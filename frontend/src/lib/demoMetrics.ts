import { parser } from '@prometheus-io/lezer-promql';
import { ApiError } from './client';
import { parseDuration, validateRange } from './promql';
import type { ParseableClient, PromqlLabels, PromqlMetadataRequest, PromqlSample } from './types';

const unsupportedMessage =
  'Demo PromQL supports selectors, rate/increase/irate/delta, *_over_time and sum/avg/min/max/count. Connect to a server for other PromQL.';
const functions = [
  'rate',
  'increase',
  'irate',
  'delta',
  'avg_over_time',
  'max_over_time',
  'min_over_time',
  'sum_over_time',
] as const;
const aggregations = ['sum', 'avg', 'min', 'max', 'count'] as const;
type FunctionName = (typeof functions)[number];
type Aggregation = (typeof aggregations)[number];
type LabelMatcher = { label: string; op: string; value: string; regex?: RegExp };
type Selector = { kind: 'selector'; name?: string; matchers: LabelMatcher[]; window?: number };
type Expression =
  | Selector
  | { kind: 'scalar'; value: number }
  | { kind: 'function'; name: FunctionName; selector: Selector }
  | {
      kind: 'aggregate';
      name: Aggregation;
      expression: Expression;
      grouping?: { mode: 'by' | 'without'; labels: string[] };
    };
type Token = { kind: 'word' | 'string' | 'number' | 'duration' | 'symbol'; value: string };
type FixtureSeries = { metric: PromqlLabels; value: (index: number) => number };
type Value = { metric: PromqlLabels; value: number };

function fail(error: string, status = 400): never {
  throw new ApiError(error, status, {
    status: 'error',
    errorType: status === 400 ? 'bad_data' : 'execution',
    error,
  });
}
const unsupported = (): never => fail(unsupportedMessage, 422);
const syntax = (): never => fail('Invalid demo PromQL syntax.');

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  const stack: string[] = [];
  let position = 0;
  while (position < query.length) {
    const remainder = query.slice(position);
    const ignored = /^(?:\s+|#[^\n]*)/.exec(remainder);
    if (ignored) {
      position += ignored[0].length;
      continue;
    }
    const quote = query[position];
    if (['"', "'", '`'].includes(quote)) {
      position++;
      let value = '',
        closed = false;
      while (position < query.length) {
        const character = query[position++];
        if (character === quote) {
          closed = true;
          break;
        }
        if (character === '\\' && quote !== '`') {
          const escaped = query[position++];
          const escapes: Record<string, string> = {
            n: '\n',
            r: '\r',
            t: '\t',
            b: '\b',
            f: '\f',
            v: '\v',
            '\\': '\\',
            '"': '"',
            "'": "'",
          };
          if (escaped === 'x' || escaped === 'u' || escaped === 'U') {
            const size = escaped === 'x' ? 2 : escaped === 'u' ? 4 : 8;
            const digits = query.slice(position, position + size);
            const point = parseInt(digits, 16);
            if (digits.length !== size || !/^[\da-f]+$/i.test(digits) || point > 0x10ffff) syntax();
            value += String.fromCodePoint(point);
            position += size;
          } else if (escaped !== undefined && Object.hasOwn(escapes, escaped))
            value += escapes[escaped];
          else syntax();
        } else value += character;
      }
      if (!closed) syntax();
      tokens.push({ kind: 'string', value });
      continue;
    }
    const duration = /^\d+(?:\.\d+)?(?:ms|[ywdhms])(?:\d+(?:\.\d+)?(?:ms|[ywdhms]))*/.exec(
      remainder,
    );
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(remainder);
    const word = /^[a-zA-Z_:][a-zA-Z0-9_:]*/.exec(remainder);
    const symbol = /^(?:!=|=~|!~|==|>=|<=|[{}()[\],=+\-*/%^<>@])/.exec(remainder);
    const match = duration ?? number ?? word ?? symbol ?? unsupported();
    const value = match[0];
    position += value.length;
    tokens.push({
      kind: duration ? 'duration' : number ? 'number' : word ? 'word' : 'symbol',
      value,
    });
    if (['{', '(', '['].includes(value)) stack.push(value);
    if (['}', ')', ']'].includes(value)) {
      const opening = { '}': '{', ')': '(', ']': '[' }[value];
      if (stack.pop() !== opening) syntax();
    }
  }
  if (stack.length || !tokens.length) syntax();
  return tokens;
}

function parse(query: string): Expression {
  if (new TextEncoder().encode(query).length > 4096)
    fail('PromQL queries cannot exceed 4096 bytes.');
  let invalid = false;
  parser.parse(query).iterate({
    enter(node) {
      if (node.type.isError) invalid = true;
    },
  });
  if (invalid) syntax();
  const tokens = tokenize(query);
  let position = 0;
  const peek = (value: string) =>
    tokens[position]?.kind !== 'string' && tokens[position]?.value === value;
  const expect = (value: string) => {
    if (!peek(value)) unsupported();
    position++;
  };
  const label = () => {
    const token = tokens[position++];
    if (!token || !['word', 'string'].includes(token.kind)) return unsupported();
    return token.value;
  };
  function selector(): Selector {
    const result: Selector = { kind: 'selector', matchers: [] };
    if (!peek('{')) result.name = label();
    if (peek('{')) {
      position++;
      while (!peek('}')) {
        const token = tokens[position];
        const name = label();
        if (token.kind === 'string' && (peek(',') || peek('}'))) {
          if (result.name !== undefined) syntax();
          result.name = name;
        } else {
          const op = tokens[position++]?.value;
          const value = tokens[position++];
          if (!['=', '!=', '=~', '!~'].includes(op) || value?.kind !== 'string') syntax();
          let regex: RegExp | undefined;
          if (op === '=~' || op === '!~') {
            try {
              regex = new RegExp(`^(?:${value.value})$`, 'u');
            } catch {
              syntax();
            }
          }
          result.matchers.push({ label: name, op, value: value.value, regex });
        }
        if (peek('}')) break;
        expect(',');
      }
      expect('}');
    }
    if (peek('[')) {
      position++;
      const token = tokens[position++];
      if (token?.kind !== 'duration') syntax();
      result.window = parseDuration(token.value);
      if (result.window === undefined || result.window <= 0) syntax();
      expect(']');
    }
    return result;
  }
  function grouping(): { mode: 'by' | 'without'; labels: string[] } | undefined {
    if (!peek('by') && !peek('without')) return undefined;
    const mode = tokens[position++].value as 'by' | 'without';
    expect('(');
    const labels: string[] = [];
    while (!peek(')')) {
      labels.push(label());
      if (peek(')')) break;
      expect(',');
    }
    expect(')');
    return { mode, labels };
  }
  function expression(allowAggregate = true): Expression {
    const token = tokens[position];
    if (!token) return syntax();
    if (token.kind === 'number' || peek('+') || peek('-')) {
      let sign = 1;
      if (peek('+') || peek('-')) sign = tokens[position++].value === '-' ? -1 : 1;
      const scalar = tokens[position++];
      if (scalar?.kind !== 'number') return unsupported();
      const value = sign * Number(scalar.value);
      if (!Number.isFinite(value)) syntax();
      return { kind: 'scalar', value };
    }
    if (
      token.kind === 'word' &&
      aggregations.includes(token.value as Aggregation) &&
      ['(', 'by', 'without'].includes(tokens[position + 1]?.value)
    ) {
      if (!allowAggregate) unsupported();
      position++;
      const prefix = grouping();
      expect('(');
      const inner = expression(false);
      expect(')');
      const suffix = grouping();
      if (prefix && suffix) syntax();
      return {
        kind: 'aggregate',
        name: token.value as Aggregation,
        expression: inner,
        grouping: prefix ?? suffix,
      };
    }
    if (token.kind === 'word' && tokens[position + 1]?.value === '(') {
      if (!functions.includes(token.value as FunctionName)) unsupported();
      position += 2;
      const inner = selector();
      if (inner.window === undefined) unsupported();
      expect(')');
      return { kind: 'function', name: token.value as FunctionName, selector: inner };
    }
    return selector();
  }
  const result = expression();
  if (position !== tokens.length) unsupported();
  return result;
}

function selects(selector: Selector, metric: PromqlLabels): boolean {
  return (
    (selector.name === undefined || metric.__name__ === selector.name) &&
    selector.matchers.every(({ label, op, value, regex }) => {
      const actual = metric[label] ?? '';
      return op === '='
        ? actual === value
        : op === '!='
          ? actual !== value
          : op === '=~'
            ? regex!.test(actual)
            : !regex!.test(actual);
    })
  );
}

function fixture(): FixtureSeries[] {
  const series: FixtureSeries[] = [];
  for (let host = 0; host < 4; host++) {
    const labels = {
      host: `node-${String(host + 1).padStart(2, '0')}`,
      'service.name': host % 2 ? 'inventory' : 'checkout',
    };
    series.push({
      metric: { __name__: 'system.cpu.load_average.1m', ...labels },
      value: (index) =>
        0.6 + host * 0.4 + Math.sin(index / 18 + host) * 0.2 + Math.cos(index / 51) * 0.12,
    });
    series.push({
      metric: { __name__: 'process.memory.usage', ...labels },
      value: (index) => 220e6 + host * 50e6 + Math.sin(index / 31 + host) * 15e6,
    });
  }
  let index = 0;
  const reset = (7 * 86400) / 15 / 2;
  for (const service of ['checkout', 'inventory'])
    for (const method of ['GET', 'POST'])
      for (const status of ['200', '500']) {
        const increment = 40 + index++ * 5;
        series.push({
          metric: { __name__: 'http.server.requests', 'service.name': service, method, status },
          value: (point) => (point < reset ? point : point - reset) * increment,
        });
      }
  return series;
}

export function createDemoMetrics(
  now = Date.now(),
): Pick<
  ParseableClient,
  'promqlQuery' | 'promqlQueryRange' | 'promqlLabels' | 'promqlLabelValues'
> {
  const anchor = Math.floor(now / 15000) * 15;
  const oldest = anchor - 7 * 86400;
  const series = fixture();
  const currentTime = () => Math.round(Date.now()) / 1000;
  async function ready(stream: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await Promise.resolve();
    signal?.throwIfAborted();
    if (stream !== 'demo_metrics') fail('PromQL requires the demo_metrics metrics dataset.');
  }
  function samples(item: FixtureSeries, time: number, window: number): PromqlSample[] {
    const first = Math.max(0, Math.floor((time - window - oldest) / 15) + 1);
    const last = Math.min((anchor - oldest) / 15, Math.floor((time - oldest) / 15));
    return Array.from({ length: Math.max(0, last - first + 1) }, (_, offset) => {
      const index = first + offset;
      return [oldest + index * 15, String(item.value(index))];
    });
  }
  function evaluate(expression: Expression, time: number): Value[] {
    if (expression.kind === 'scalar') return [{ metric: {}, value: expression.value }];
    if (expression.kind === 'selector') {
      if (expression.window !== undefined) return unsupported();
      if (time < oldest || time > anchor + 300) return [];
      const index = Math.floor((Math.min(time, anchor) - oldest) / 15);
      return series
        .filter((item) => selects(expression, item.metric))
        .map((item) => ({ metric: { ...item.metric }, value: item.value(index) }));
    }
    if (expression.kind === 'function') {
      const { selector, name } = expression;
      return series
        .filter((item) => selects(selector, item.metric))
        .flatMap((item) => {
          const points = samples(item, time, selector.window!);
          const values = points.map(([, value]) => Number(value));
          if (!points.length) return [];
          let value: number;
          if (name.endsWith('_over_time')) {
            value =
              name === 'min_over_time'
                ? Math.min(...values)
                : name === 'max_over_time'
                  ? Math.max(...values)
                  : values.reduce((total, point) => total + point, 0);
            if (name === 'avg_over_time') value /= values.length;
          } else {
            if (points.length < 2) return [];
            const first = name === 'irate' ? points.length - 2 : 0;
            const elapsed = points.at(-1)![0] - points[first][0];
            let difference = 0;
            for (let index = first + 1; index < points.length; index++)
              difference +=
                values[index] < values[index - 1]
                  ? values[index]
                  : values[index] - values[index - 1];
            value = name === 'delta' ? values.at(-1)! - values[0] : difference;
            value =
              (value / elapsed) * (name === 'increase' || name === 'delta' ? selector.window! : 1);
          }
          const { __name__: _name, ...metric } = item.metric;
          return [{ metric, value }];
        });
    }
    if (expression.expression.kind === 'scalar') return unsupported();
    const groups = new Map<string, { metric: PromqlLabels; values: number[] }>();
    for (const item of evaluate(expression.expression, time)) {
      const grouping = expression.grouping;
      const metric = Object.fromEntries(
        Object.entries(item.metric)
          .filter(([key]) =>
            grouping?.mode === 'by'
              ? grouping.labels.includes(key)
              : grouping?.mode === 'without'
                ? key !== '__name__' && !grouping.labels.includes(key)
                : false,
          )
          .sort(([a], [b]) => a.localeCompare(b)),
      );
      const key = JSON.stringify(metric);
      const group = groups.get(key) ?? { metric, values: [] };
      group.values.push(item.value);
      groups.set(key, group);
    }
    return [...groups.values()].map(({ metric, values }) => ({
      metric,
      value:
        expression.name === 'count'
          ? values.length
          : expression.name === 'min'
            ? Math.min(...values)
            : expression.name === 'max'
              ? Math.max(...values)
              : values.reduce((sum, value) => sum + value, 0) /
                (expression.name === 'avg' ? values.length : 1),
    }));
  }
  function metadataItems(request: PromqlMetadataRequest): FixtureSeries[] {
    const end = request.end ?? currentTime();
    const start = request.start ?? end - 86400;
    const error = validateRange({ start, end, step: Math.max(1, end - start) });
    if (error) fail(error);
    if ((request.match?.length ?? 0) > 16) fail('Metadata accepts at most 16 match[] selectors.');
    const selectors = request.match?.map((query) => {
      const expression = parse(query);
      if (expression.kind !== 'selector' || expression.window !== undefined) return syntax();
      return expression;
    });
    if (end < oldest || start > anchor) return [];
    return series.filter(
      (item) => !selectors?.length || selectors.some((selector) => selects(selector, item.metric)),
    );
  }
  function metadata(values: string[], limit = 0) {
    if (!Number.isInteger(limit) || limit < 0 || limit > 10000)
      fail('Metadata limit must be between 0 and 10000.');
    const sorted = [...new Set(values)].sort();
    const maximum = limit || 10000;
    return { data: sorted.slice(0, maximum), truncated: sorted.length > maximum };
  }
  return {
    async promqlQuery({ stream, query, time = currentTime() }, signal) {
      await ready(stream, signal);
      if (!Number.isFinite(time)) fail('Enter a valid query time.');
      const expression = parse(query);
      if (expression.kind === 'scalar')
        return { resultType: 'scalar', result: [time, String(expression.value)] };
      if (expression.kind === 'selector' && expression.window !== undefined)
        return {
          resultType: 'matrix',
          result: series
            .filter((item) => selects(expression, item.metric))
            .flatMap((item) => {
              const values = samples(item, time, expression.window!);
              return values.length ? [{ metric: { ...item.metric }, values }] : [];
            }),
        };
      return {
        resultType: 'vector',
        result: evaluate(expression, time).map(({ metric, value }) => ({
          metric,
          value: [time, String(value)],
        })),
      };
    },
    async promqlQueryRange({ stream, query, start, end, step }, signal) {
      await ready(stream, signal);
      const error = validateRange({ start, end, step });
      if (error) fail(error);
      const expression = parse(query);
      const seconds = parseDuration(step)!;
      const result = new Map<string, { metric: PromqlLabels; values: PromqlSample[] }>();
      const count = Math.floor((end - start) / seconds) + 1;
      for (let index = 0; index < count; index++) {
        signal?.throwIfAborted();
        const time = Math.round((start + index * seconds) * 1000) / 1000;
        for (const { metric, value } of evaluate(expression, time)) {
          const key = JSON.stringify(Object.entries(metric).sort(([a], [b]) => a.localeCompare(b)));
          const item = result.get(key) ?? { metric, values: [] };
          item.values.push([time, String(value)]);
          result.set(key, item);
        }
      }
      return { resultType: 'matrix', result: [...result.values()] };
    },
    async promqlLabels(request, signal) {
      await ready(request.stream, signal);
      return metadata(
        metadataItems(request).flatMap((item) => Object.keys(item.metric)),
        request.limit,
      );
    },
    async promqlLabelValues(label, request, signal) {
      await ready(request.stream, signal);
      return metadata(
        metadataItems(request).flatMap((item) =>
          Object.hasOwn(item.metric, label) ? [item.metric[label]] : [],
        ),
        request.limit,
      );
    },
  };
}
