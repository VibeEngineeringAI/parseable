import { describe, expect, it } from 'vitest';
import {
  chartResults,
  createRunSnapshot,
  insertBrowserQuery,
  instantRows,
  metadataRequest,
  parseExplorerSearch,
  rangeRows,
  requestsForSnapshot,
  selectorWithValue,
  serializeExplorerState,
  snapshotState,
  stepError,
  type ExplorerState,
  type QueryResult,
} from './helpers';

const now = Date.parse('2026-10-09T12:00:00Z');
const state: ExplorerState = { queries: ['{"cpu.load"}'], type: 'both', step: '', range: '1h' };
const result = (id: string, data: Partial<QueryResult>): QueryResult => ({
  id,
  pending: 0,
  errors: [],
  ...data,
});

describe('Metrics URL state', () => {
  it('starts with an empty query and the classic defaults', () => {
    expect(parseExplorerSearch('')).toEqual({ queries: [''], type: 'both', step: '', range: '1h' });
  });
  it.each(['range', 'instant', 'both'] as const)(
    'round trips %s and repeated queries without changing text',
    (type) => {
      const input = {
        queries: ['{"cpu.load", host="a&b"}', '', 'sum(rate(counter[5m]))'],
        type,
        step: '1m30s',
        range: '6h' as const,
      };
      const search = serializeExplorerState(input);
      expect(new URLSearchParams(search).getAll('query')).toEqual(input.queries);
      expect(parseExplorerSearch(search)).toEqual(input);
    },
  );
  it('normalizes and restores absolute bounds', () => {
    const parsed = parseExplorerSearch(
      '?start=2026-10-09T10:00:00%2B00:00&end=2026-10-09T12:00:00Z',
    );
    expect(parsed.range).toEqual({
      startTime: '2026-10-09T10:00:00.000Z',
      endTime: '2026-10-09T12:00:00.000Z',
    });
    expect(parseExplorerSearch(serializeExplorerState(parsed))).toEqual(parsed);
  });
  it.each(['nonsense', '-5s', '0', 'NaN', '1m2h', '1.5m', '32d', '2678400.001'])(
    'falls back from an invalid URL step %s',
    (step) => {
      expect(parseExplorerSearch(`?step=${step}`).step).toBe('');
    },
  );
  it.each([
    '?range=2h&type=unknown',
    '?start=invalid&end=2026-10-09T12:00:00Z',
    '?start=2026-10-09T12:00:00Z&end=2026-10-09T10:00:00Z',
    '?start=2026-08-09T12:00:00Z&end=2026-10-09T12:00:00Z',
    '?start=2026-10-09T10:00:00Z',
  ])('falls back from invalid range state %s', (search) => {
    expect(parseExplorerSearch(search).range).toBe('1h');
    expect(parseExplorerSearch(search).type).toBe('both');
  });
  it('caps shared links at five query rows', () => {
    expect(parseExplorerSearch('?query=1&query=2&query=3&query=4&query=5&query=6').queries).toEqual(
      ['1', '2', '3', '4', '5'],
    );
  });
});

describe('Applied query snapshots', () => {
  it('sends only contract params with shared bounds for Both', () => {
    const { snapshot } = createRunSnapshot(state, 'metrics_a', 800, now);
    expect(snapshot).toBeDefined();
    expect(requestsForSnapshot(snapshot!)).toEqual([
      {
        id: 'A',
        kind: 'range',
        request: {
          stream: 'metrics_a',
          query: state.queries[0],
          start: now / 1000 - 3600,
          end: now / 1000,
          step: '15s',
        },
      },
      {
        id: 'A',
        kind: 'instant',
        request: { stream: 'metrics_a', query: state.queries[0], time: now / 1000 },
      },
    ]);
  });
  it.each(['range', 'instant'] as const)('sends only the %s endpoint for that type', (type) => {
    const { snapshot } = createRunSnapshot({ ...state, type }, 'metrics_a', 400, now);
    expect(requestsForSnapshot(snapshot!).map((plan) => plan.kind)).toEqual([type]);
  });
  it('resolves auto steps separately for different range-vector windows', () => {
    const { snapshot } = createRunSnapshot(
      { ...state, queries: ['rate(counter[8s])', '', 'cpu'] },
      'metrics_a',
      400,
      now,
    );
    expect(snapshot?.queries.map(({ id, resolvedStep }) => [id, resolvedStep])).toEqual([
      ['A', '2s'],
      ['C', '15s'],
    ]);
  });
  it('snapshots text and keeps the user step verbatim', () => {
    const input = { ...state, queries: ['cpu', '', 'counter'], step: '1m30s' };
    const { snapshot } = createRunSnapshot(input, 'metrics_a', 400, now);
    input.queries[0] = 'edited';
    expect(snapshot?.queries[0].query).toBe('cpu');
    expect(requestsForSnapshot(snapshot!)[0].request).toMatchObject({ step: '1m30s' });
    expect(snapshotState(snapshot!, '24h')).toEqual({
      queries: ['cpu', '', 'counter'],
      step: '1m30s',
      type: 'both',
      range: '24h',
    });
  });
  it('refreshes applied configuration with fresh bounds', () => {
    const applied = createRunSnapshot(state, 'metrics_a', 800, now).snapshot!;
    const refreshed = createRunSnapshot(
      snapshotState(applied, '6h'),
      'metrics_a',
      800,
      now + 5000,
    ).snapshot!;
    expect(refreshed.end).toBe(applied.end + 5);
    expect(refreshed.end - refreshed.start).toBe(6 * 3600);
    expect(refreshed.queries[0].query).toBe(applied.queries[0].query);
  });
  it.each(['wrong', '0s', '-2', '0', '1.5m', '1m0.5s'])(
    'rejects invalid step %s before constructing requests',
    (step) => {
      expect(createRunSnapshot({ ...state, step }, 'metrics_a', 800, now)).toEqual({
        error: 'Step must be a positive duration or number of seconds.',
      });
    },
  );
  it.each(['32d', '31d1ms', '2678400.001'])(
    'rejects an oversized step %s even for Instant',
    (step) => {
      expect(stepError(step)).toBe('Step cannot exceed 31 days.');
      expect(createRunSnapshot({ ...state, type: 'instant', step }, 'metrics_a', 800, now)).toEqual(
        {
          error: 'Step cannot exceed 31 days.',
        },
      );
    },
  );
  it.each(['90s', '1m30s', '1.5', '31d', '2678400'])(
    'accepts a server-compatible step %s before constructing requests',
    (step) => {
      expect(stepError(step)).toBeUndefined();
      const { snapshot } = createRunSnapshot({ ...state, step }, 'metrics_a', 800, now);
      expect(requestsForSnapshot(snapshot!)[0].request).toHaveProperty('step', step);
    },
  );
  it('rejects too many steps before constructing requests', () => {
    expect(
      createRunSnapshot({ ...state, range: '7d', step: '1s' }, 'metrics_a', 800, now).error,
    ).toContain('11000');
  });
  it('does not apply range evaluation-step limits to Instant', () => {
    expect(
      createRunSnapshot(
        { ...state, type: 'instant', range: '7d', step: '1s' },
        'metrics_a',
        800,
        now,
      ).snapshot,
    ).toBeDefined();
  });
  it('rejects ranges longer than 31 days even for Instant', () => {
    expect(
      createRunSnapshot(
        {
          ...state,
          type: 'instant',
          range: { startTime: '2026-08-01T00:00:00Z', endTime: '2026-10-09T00:00:00Z' },
        },
        'metrics_a',
        800,
        now,
      ).error,
    ).toContain('31 days');
  });
  it('does not construct an empty run', () => {
    expect(
      createRunSnapshot({ ...state, queries: [' ', ''] }, 'metrics_a', 800, now).snapshot,
    ).toBeUndefined();
  });
  it('scopes metadata with bounded times, a limit, and repeatable selectors', () => {
    expect(metadataRequest('metrics_a', { start: 1, end: 2 }, ['cpu.load', 'counter'])).toEqual({
      stream: 'metrics_a',
      start: 1,
      end: 2,
      limit: 1000,
      match: ['{__name__="cpu.load"}', '{__name__="counter"}'],
    });
    expect(metadataRequest('metrics_a', { start: 1, end: 2 })).not.toHaveProperty('match');
  });
  it.each([
    { start: 0, end: 32 * 86400 },
    { start: 0, end: 31 * 86400 + 0.001 },
    { start: 2, end: 1 },
    { start: NaN, end: 1 },
    { start: 0, end: Infinity },
  ])('does not construct metadata requests for invalid bounds %#', (bounds) => {
    expect(metadataRequest('metrics_a', bounds)).toBeUndefined();
    expect(metadataRequest('metrics_a', bounds, ['cpu'])).toBeUndefined();
  });
  it.each([
    { start: 0, end: 31 * 86400 },
    { start: 1, end: 1 },
  ])('accepts inclusive metadata bounds at the server limits %#', (bounds) => {
    expect(metadataRequest('metrics_a', bounds)).toMatchObject(bounds);
  });
});

describe('Label browser insertion', () => {
  it('uses the active empty row and leaves other drafts intact', () => {
    expect(insertBrowserQuery(['cpu', ''], 1, 'cpu.load')).toEqual({
      queries: ['cpu', '{"cpu.load"}'],
      active: 1,
    });
  });
  it('adds a metric as a new row whenever the active row has text', () => {
    expect(insertBrowserQuery(['rate(counter[5m])'], 0, 'cpu.load')).toEqual({
      queries: ['rate(counter[5m])', '{"cpu.load"}'],
      active: 1,
    });
  });
  it.each(['', ' {"cpu.load"} ', '{__name__="cpu.load"}'])(
    'puts a matcher into an empty or plain selector %s',
    (query) => {
      expect(
        insertBrowserQuery([query], 0, 'cpu.load', { label: 'host', value: 'a' }).queries,
      ).toEqual(['{"cpu.load", host="a"}']);
    },
  );
  it('preserves an edited expression and adds a new matched selector', () => {
    expect(insertBrowserQuery(['sum(cpu)'], 0, 'cpu', { label: 'host', value: 'a' })).toEqual({
      queries: ['sum(cpu)', 'cpu{host="a"}'],
      active: 1,
    });
  });
  it('quotes dotted labels and escapes values with the existing helpers', () => {
    expect(selectorWithValue('cpu.load', 'service.name', 'a"\\\nb')).toBe(
      '{"cpu.load", "service.name"="a\\"\\\\\\nb"}',
    );
  });
  it.each(['cpu', 'cpu.load'])(
    'keeps a single metric-name restriction when inserting __name__ for %s',
    (metric) => {
      const selector = metric === 'cpu' ? 'cpu' : '{"cpu.load"}';
      expect(selectorWithValue(metric, '__name__', metric)).toBe(selector);
      for (const query of ['', selector, `{__name__="${metric}"}`]) {
        expect(
          insertBrowserQuery([query], 0, metric, { label: '__name__', value: metric }),
        ).toEqual({
          queries: [selector],
          active: 0,
        });
      }
    },
  );
  it('explains a full panel without changing any draft', () => {
    const queries = ['a', 'b', 'c', 'd', 'e'];
    const insertion = insertBrowserQuery(queries, 0, 'cpu');
    expect(insertion.queries).toBe(queries);
    expect(insertion.error).toContain('Remove a query');
  });
  it('can replace a plain selector even with five rows', () => {
    expect(
      insertBrowserQuery(['cpu', 'b', 'c', 'd', 'e'], 0, 'cpu', { label: 'host', value: 'a' })
        .queries[0],
    ).toBe('cpu{host="a"}');
  });
});

describe('Metrics result presentation', () => {
  const a = result('A', {
    range: {
      resultType: 'matrix',
      result: [
        {
          metric: { __name__: 'cpu', host: 'b', service: 'app' },
          values: [
            [1, 'NaN'],
            [3, '4'],
          ],
        },
        {
          metric: { __name__: 'cpu', host: 'a', service: 'app' },
          values: [
            [1, '1'],
            [3, '3'],
          ],
        },
      ],
    },
  });
  const b = result('B', {
    range: {
      resultType: 'matrix',
      result: [
        {
          metric: { __name__: 'cpu', host: 'a' },
          values: [
            [2, '2'],
            [3, '+Inf'],
          ],
        },
      ],
    },
  });
  it('aligns query results onto a shared timestamp union with gaps', () => {
    const chart = chartResults([a, b], 2);
    expect(chart.timestamps).toEqual([1, 2, 3]);
    expect(chart.series.map(({ label, values }) => ({ label, values }))).toEqual([
      { label: 'A: {host="a"}', values: [1, null, 3] },
      { label: 'A: {host="b"}', values: [null, null, 4] },
      { label: 'B: {host="a"}', values: [null, 2, null] },
    ]);
    expect(new Set(chart.series.map(({ id }) => id)).size).toBe(3);
  });
  it('keeps query identity while omitting the single-query label prefix', () => {
    const chart = chartResults([a], 1);
    expect(chart.series[0].id).toMatch(/^A:/);
    expect(chart.series[0].label).toBe('{host="a"}');
  });
  it('summarizes every chart series, including non-finite gaps', () => {
    expect(rangeRows([a], 1)).toEqual([
      { Series: '{host="a"}', Last: 3, Min: 1, Max: 3, Avg: 2 },
      { Series: '{host="b"}', Last: 4, Min: 4, Max: 4, Avg: 4 },
    ]);
  });
  it('keeps the name in instant vectors and treats scalar/string results like scalars', () => {
    expect(
      instantRows(
        [
          result('A', {
            instant: {
              resultType: 'vector',
              result: [{ metric: { __name__: 'cpu.load', host: 'a' }, value: [1, '2.5'] }],
            },
          }),
          result('B', { instant: { resultType: 'scalar', result: [1, '3'] } }),
          result('C', { instant: { resultType: 'string', result: [1, 'NaN'] } }),
        ],
        3,
      ),
    ).toEqual([
      { Series: 'A: cpu.load{host="a"}', Value: 2.5 },
      { Series: 'B: scalar', Value: 3 },
      { Series: 'C: scalar', Value: null },
    ]);
  });
  it('uses the last timestamp of instant matrices and includes the sample count', () => {
    expect(
      instantRows(
        [
          result('A', {
            instant: {
              resultType: 'matrix',
              result: [
                {
                  metric: { __name__: 'cpu' },
                  values: [
                    [5, '9'],
                    [1, '2'],
                  ],
                },
                { metric: {}, values: [] },
              ],
            },
          }),
        ],
        1,
      ),
    ).toEqual([
      { Series: 'cpu{}', Value: 9, Samples: 2 },
      { Series: '{}', Value: null, Samples: 0 },
    ]);
  });
  it('does not lose successful results when another query fails', () => {
    const failed = result('B', { errors: [{ kind: 'range', error: new Error('failure') }] });
    expect(chartResults([a, failed], 2).series).toHaveLength(2);
  });
});
