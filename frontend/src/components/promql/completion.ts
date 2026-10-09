import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import {
  newCompleteStrategy,
  type CompleteStrategy,
  type PrometheusClient,
} from '@prometheus-io/codemirror-promql';

export interface PromqlMetadataSource {
  metricNames(signal?: AbortSignal): Promise<string[]>;
  labelNames(metric?: string, signal?: AbortSignal): Promise<string[]>;
  labelValues(label: string, metric?: string, signal?: AbortSignal): Promise<string[]>;
}

const supportedFunctions = new Set([
  'rate',
  'increase',
  'delta',
  'irate',
  'idelta',
  'sum_over_time',
  'avg_over_time',
  'count_over_time',
  'min_over_time',
  'max_over_time',
  'last_over_time',
  'present_over_time',
  'changes',
  'resets',
  'abs',
  'ceil',
  'floor',
  'sqrt',
  'exp',
  'ln',
  'log2',
  'log10',
  'timestamp',
  'scalar',
  'vector',
  'time',
]);
const supportedAggregations = new Set([
  'sum',
  'avg',
  'count',
  'min',
  'max',
  'group',
  'stddev',
  'stdvar',
]);
const supportedKeywords = new Set(['by', 'without', 'bool', 'on', 'ignoring']);
const unsupportedOperators = new Set([
  'and',
  'or',
  'unless',
  'offset',
  '@',
  'start()',
  'end()',
  '</',
  '>/',
]);

export function filterSupportedCompletions(options: readonly Completion[]): Completion[] {
  return options.filter((option) => {
    // Metadata can have the same spelling as a function or keyword.
    if (option.type === 'constant' || option.type === 'text') return true;
    if (option.detail === 'snippet') {
      const calls = [...option.label.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)];
      return calls.every(
        ([, name]) =>
          supportedFunctions.has(name) ||
          supportedAggregations.has(name) ||
          supportedKeywords.has(name),
      );
    }
    if (option.detail === 'aggregation') return supportedAggregations.has(option.label);
    if (option.type === 'function') return supportedFunctions.has(option.label);
    if (option.type === 'keyword') return supportedKeywords.has(option.label);
    return !unsupportedOperators.has(option.label);
  });
}

export function createMetadataClient(metadata: PromqlMetadataSource): PrometheusClient {
  const cache = new Map<string, { expires: number; value: Promise<string[]> }>();
  const controllers = new Set<AbortController>();
  let destroyed = false;

  function cached(
    key: string,
    fetch: (signal: AbortSignal) => Promise<string[]>,
  ): Promise<string[]> {
    if (destroyed) return Promise.resolve([]);
    const existing = cache.get(key);
    if (existing && existing.expires > Date.now()) return existing.value;
    cache.delete(key);
    const controller = new AbortController();
    controllers.add(controller);
    const value = Promise.resolve()
      .then(() => (controller.signal.aborted ? [] : fetch(controller.signal)))
      .catch(() => [])
      .finally(() => controllers.delete(controller));
    // Bound each editor's cache, including pending and empty responses.
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires: Date.now() + 60_000, value });
    return value;
  }

  return {
    metricNames: () => cached('metrics', (signal) => metadata.metricNames(signal)),
    labelNames: (metric) =>
      cached(JSON.stringify(['labels', metric]), (signal) =>
        metadata.labelNames(metric || undefined, signal),
      ),
    labelValues: (label, metric) =>
      cached(JSON.stringify(['values', label, metric]), (signal) =>
        metadata.labelValues(label, metric || undefined, signal),
      ),
    metricMetadata: async () => ({}),
    series: async () => [],
    flags: async () => ({}),
    destroy: () => {
      destroyed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      cache.clear();
    },
  };
}

export function quoteCompletionName(
  option: Completion,
  labelContext: boolean,
  quote: 'none' | 'name' | 'content' = 'none',
): Completion {
  if (option.type !== 'constant') return option;
  const name = JSON.stringify(option.label);
  if (quote === 'name') return { ...option, apply: name };
  if (quote === 'content') return { ...option, apply: name.slice(1, -1) };
  const legacyName = labelContext ? /^[a-zA-Z_][a-zA-Z0-9_]*$/ : /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
  if (legacyName.test(option.label)) return option;
  return { ...option, apply: labelContext ? name : `{${name}}` };
}

function readNameContext(context: CompletionContext) {
  const node = syntaxTree(context.state).resolveInner(context.pos, -1);
  let quoted = false;
  let labelContext = false;
  let quotedName: SyntaxNode | null = null;
  let selector: SyntaxNode | null = null;
  let aggregate: SyntaxNode | null = null;
  for (let parent: typeof node | null = node; parent; parent = parent.parent) {
    if (parent.name === 'StringLiteral') quoted = true;
    if (parent.name === 'LabelMatchers' || parent.name === 'GroupingLabels') labelContext = true;
    if (parent.name === 'QuotedLabelName') quotedName = parent;
    if (parent.name === 'VectorSelector' && !selector) selector = parent;
    if (parent.name === 'AggregateExpr' && !aggregate) aggregate = parent;
  }
  if (!selector && aggregate) {
    aggregate
      .getChild('FunctionCallBody')
      ?.cursor()
      .iterate((child) => {
        if (child.name === 'VectorSelector' && !selector) {
          selector = child.node;
          return false;
        }
      });
  }
  const matchers = selector?.getChild('LabelMatchers');
  const identifier = selector?.getChild('Identifier');
  let metric = identifier ? context.state.sliceDoc(identifier.from, identifier.to) : undefined;
  const firstName = matchers?.firstChild;
  if (!metric && firstName?.name === 'QuotedLabelName') {
    metric = decodeName(context.state.sliceDoc(firstName.from, firstName.to));
  }
  if (!metric && matchers) {
    for (const matcher of [
      ...matchers.getChildren('UnquotedLabelMatcher'),
      ...matchers.getChildren('QuotedLabelMatcher'),
    ]) {
      const name = matcher.firstChild;
      const value = matcher.getChild('StringLiteral');
      const label = name ? context.state.sliceDoc(name.from, name.to) : '';
      if (
        (label === '__name__' || label === '"__name__"') &&
        matcher.getChild('MatchOp')?.getChild('EqlSingle') &&
        value
      ) {
        metric = decodeName(context.state.sliceDoc(value.from, value.to));
      }
    }
  }
  // The library currently treats every standalone quoted name in a selector as a metric.
  const quotedLabel =
    quotedName?.parent?.name === 'LabelMatchers' &&
    quotedName.from !== quotedName.parent.firstChild?.from;
  const word = context.matchBefore(/[a-zA-Z_:][a-zA-Z0-9_:.]*$/);
  return { quoted, labelContext, quotedLabel, word, metric };
}

function decodeName(text: string): string | undefined {
  try {
    const name: unknown = JSON.parse(text);
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}

function quoteNames(
  result: CompletionResult,
  context: CompletionContext,
  info: ReturnType<typeof readNameContext>,
): CompletionResult {
  const { quoted, labelContext, word } = info;
  const quote = quoted
    ? /^["'`]/.test(context.state.sliceDoc(result.from, result.from + 1))
      ? 'name'
      : 'content'
    : 'none';
  const prefix =
    quote === 'name'
      ? context.state
          .sliceDoc(result.from + 1, context.pos)
          .replace(/["'`]$/, '')
          .toLowerCase()
      : '';
  return {
    ...result,
    from: !quoted && word && word.from < result.from ? word.from : result.from,
    // Quoted names replace the whole literal; its opening quote must not enter CM's text filter.
    filter: quote === 'name' ? false : result.filter,
    validFor: quote !== 'name' && result.validFor ? /^[a-zA-Z0-9_:.]*$/ : undefined,
    options: filterSupportedCompletions(result.options)
      .filter((option) => quote !== 'name' || option.label.toLowerCase().includes(prefix))
      .map((option) => quoteCompletionName(option, labelContext, quote)),
  };
}

export function createCompletionStrategy(metadata?: PromqlMetadataSource): CompleteStrategy {
  const client = metadata ? createMetadataClient(metadata) : undefined;
  const strategy = newCompleteStrategy(client ? { remote: client } : undefined);
  return {
    promQL: async (context) => {
      const info = readNameContext(context);
      // Preserve metric scoping for quoted selectors, which the library only derives for legacy identifiers.
      const scoped =
        info.metric && client
          ? newCompleteStrategy({
              remote: {
                ...client,
                labelNames: (metric) => client.labelNames(metric || info.metric),
                labelValues: (label, metric) => client.labelValues(label, metric || info.metric),
              },
            })
          : strategy;
      let result = await scoped.promQL(context);
      if (result && info.quotedLabel && client) {
        result = {
          ...result,
          options: (await client.labelNames(info.metric)).map((label) => ({
            label,
            type: 'constant',
          })),
        };
      } else if (info.word?.text.includes('.') && !info.quoted && client) {
        const names = info.labelContext
          ? await client.labelNames(info.metric)
          : await client.metricNames(info.word.text);
        result = {
          from: info.word.from,
          to: context.pos,
          validFor: /^[a-zA-Z0-9_:.]*$/,
          options: names.map((label) => ({ label, type: 'constant' })),
        };
      }
      return result ? quoteNames(result, context, info) : null;
    },
    destroy: () => strategy.destroy?.(),
  };
}
