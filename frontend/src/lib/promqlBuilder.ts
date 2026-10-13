import { matcher, metricSelector, parseDuration } from './promql';

// This list deliberately matches src/promql/mod.rs, not all of Prometheus.
export const rangeFunctions = [
  'rate',
  'increase',
  'delta',
  'sum_over_time',
  'avg_over_time',
  'min_over_time',
  'max_over_time',
  'count_over_time',
  'last_over_time',
  'present_over_time',
] as const;
export const vectorFunctions = [
  'abs',
  'ceil',
  'floor',
  'sqrt',
  'exp',
  'ln',
  'log2',
  'log10',
] as const;
export const aggregations = ['sum', 'avg', 'min', 'max', 'count'] as const;
export type PromqlMatcher = { label: string; operator: '=' | '!=' | '=~' | '!~'; value: string };
export type PromqlOperation =
  | { kind: 'range'; name: (typeof rangeFunctions)[number]; duration: string }
  | { kind: 'function'; name: (typeof vectorFunctions)[number] }
  | {
      kind: 'aggregate';
      name: (typeof aggregations)[number];
      grouping: 'none' | 'by' | 'without';
      labels: string[];
    };
export type PromqlBuilder = {
  version: 1;
  metric: string;
  matchers: PromqlMatcher[];
  operations: PromqlOperation[];
};
export const emptyPromqlBuilder = (): PromqlBuilder => ({
  version: 1,
  metric: '',
  matchers: [],
  operations: [],
});
const labelName = (name: string) =>
  /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ? name : JSON.stringify(name);

export function compilePromqlBuilder(builder: PromqlBuilder): string {
  if (builder.version !== 1 || !builder.metric.trim()) throw new Error('Choose a metric.');
  if (builder.matchers.length > 20 || builder.operations.length > 8)
    throw new Error('Use at most 20 matchers and eight operations.');
  let query = metricSelector(builder.metric);
  if (builder.matchers.length) {
    const filters = builder.matchers
      .map((item) => {
        if (!item.label.trim() || item.label === '__name__')
          throw new Error('Enter a label; choose the metric above instead of matching __name__.');
        if (!['=', '!=', '=~', '!~'].includes(item.operator))
          throw new Error('Unsupported matcher.');
        return matcher(item.label, item.value, item.operator);
      })
      .join(', ');
    query = query.startsWith('{') ? `${query.slice(0, -1)}, ${filters}}` : `${query}{${filters}}`;
  }
  for (const [index, operation] of builder.operations.entries()) {
    if (operation.kind === 'range') {
      const seconds = parseDuration(operation.duration);
      if (index !== 0 || !rangeFunctions.includes(operation.name))
        throw new Error('A range function must be the first operation on a metric.');
      if (
        !/^(?:\d+(?:ms|[ywdhms]))+$/.test(operation.duration) ||
        seconds === undefined ||
        seconds < 0.001 ||
        seconds > 31 * 86400
      )
        throw new Error('Use a positive range duration up to 31 days, such as 5m.');
      query = `${operation.name}(${query}[${operation.duration}])`;
    } else if (operation.kind === 'function') {
      if (!vectorFunctions.includes(operation.name)) throw new Error('Unsupported function.');
      query = `${operation.name}(${query})`;
    } else {
      if (
        !aggregations.includes(operation.name) ||
        !['none', 'by', 'without'].includes(operation.grouping)
      )
        throw new Error('Unsupported aggregation.');
      if (
        operation.labels.length > 20 ||
        operation.labels.some((name) => !name.trim()) ||
        new Set(operation.labels).size !== operation.labels.length
      )
        throw new Error('Use up to 20 distinct grouping labels.');
      if (operation.grouping === 'none' && operation.labels.length)
        throw new Error('Select by or without to group labels.');
      const grouping =
        operation.grouping === 'none'
          ? ''
          : ` ${operation.grouping} (${operation.labels.map(labelName).join(', ')})`;
      query = `${operation.name}${grouping} (${query})`;
    }
  }
  return query;
}

/** Parse only the entire bounded grammar. Unknown syntax is never approximated. */
export function readPromqlBuilder(raw: string): PromqlBuilder | undefined {
  if (!raw.trim()) return emptyPromqlBuilder();
  if (raw.length > 32_768) return;
  let position = 0;
  const whitespace = () => {
    while (/\s/.test(raw[position] ?? '') && position < raw.length) position++;
  };
  const take = (token: string) => {
    whitespace();
    if (raw.startsWith(token, position)) {
      position += token.length;
      return true;
    }
    return false;
  };
  const require = (token: string) => {
    if (!take(token)) throw new Error('syntax');
  };
  const identifier = (): string => {
    whitespace();
    if (raw[position] === '"') {
      const start = position++;
      while (position < raw.length) {
        const character = raw[position++];
        if (character === '\\') position++;
        else if (character === '"') return JSON.parse(raw.slice(start, position)) as string;
      }
      throw new Error('string');
    }
    const match = /^[a-zA-Z_:][a-zA-Z0-9_:]*/.exec(raw.slice(position));
    if (!match) throw new Error('identifier');
    position += match[0].length;
    return match[0];
  };
  const grouping = () => {
    const labels: string[] = [];
    require('(');
    if (!take(')')) {
      do {
        whitespace();
        const quoted = raw[position] === '"';
        const name = identifier();
        if (!quoted && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error('label');
        labels.push(name);
      } while (take(','));
      require(')');
    }
    return labels;
  };
  const parse = (depth = 0): PromqlBuilder => {
    if (depth > 8) throw new Error('depth');
    whitespace();
    if (raw[position] === '"') throw new Error('bare quoted metric');
    const name = raw[position] === '{' ? '' : identifier();
    if ([...rangeFunctions, ...vectorFunctions, ...aggregations].includes(name as never)) {
      whitespace();
      // A metric named sum/rate remains a selector unless a call or grouping follows.
      if (raw[position] === '(' || /^(?:by|without)\b/.test(raw.slice(position))) {
        let mode: 'none' | 'by' | 'without' = 'none';
        let labels: string[] = [];
        if (/^(?:by|without)\b/.test(raw.slice(position))) {
          mode = identifier() as 'by' | 'without';
          labels = grouping();
        }
        require('(');
        const inner = parse(depth + 1);
        if (rangeFunctions.includes(name as never)) {
          if (inner.operations.length || mode !== 'none') throw new Error('range input');
          require('[');
          whitespace();
          const duration = /^(?:\d+(?:ms|[ywdhms]))+/.exec(raw.slice(position))?.[0];
          if (!duration) throw new Error('duration');
          position += duration.length;
          require(']');
          require(')');
          inner.operations.push({
            kind: 'range',
            name: name as (typeof rangeFunctions)[number],
            duration,
          });
        } else {
          require(')');
          if (aggregations.includes(name as never)) {
            whitespace();
            if (/^(?:by|without)\b/.test(raw.slice(position))) {
              if (mode !== 'none') throw new Error('duplicate grouping');
              mode = identifier() as 'by' | 'without';
              labels = grouping();
            }
            inner.operations.push({
              kind: 'aggregate',
              name: name as (typeof aggregations)[number],
              grouping: mode,
              labels,
            });
          } else {
            if (mode !== 'none') throw new Error('function grouping');
            inner.operations.push({
              kind: 'function',
              name: name as (typeof vectorFunctions)[number],
            });
          }
        }
        return inner;
      }
    }
    const builder = { ...emptyPromqlBuilder(), metric: name };
    if (take('{')) {
      whitespace();
      // UTF-8 selector syntax: {"metric.name", "label.name"="value"}.
      if (!name && raw[position] === '"') {
        const before = position;
        const candidate = identifier();
        whitespace();
        if (raw[position] === ',' || raw[position] === '}') {
          builder.metric = candidate;
          if (take('}')) return builder;
          require(',');
        } else position = before;
      }
      if (!take('}')) {
        do {
          whitespace();
          const quoted = raw[position] === '"';
          const label = identifier();
          if (!quoted && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(label)) throw new Error('label');
          whitespace();
          const operator = /^(?:=~|!~|!=|=)/.exec(raw.slice(position))?.[0] as
            PromqlMatcher['operator'] | undefined;
          if (!operator) throw new Error('matcher');
          position += operator.length;
          whitespace();
          if (raw[position] !== '"') throw new Error('value');
          const value = identifier();
          if (label === '__name__') {
            if (operator !== '=' || builder.metric) throw new Error('metric matcher');
            builder.metric = value;
          } else builder.matchers.push({ label, operator, value });
        } while (take(','));
        require('}');
      }
    }
    return builder;
  };
  try {
    const builder = parse();
    whitespace();
    if (position !== raw.length) return;
    compilePromqlBuilder(builder);
    return builder;
  } catch {
    return;
  }
}
