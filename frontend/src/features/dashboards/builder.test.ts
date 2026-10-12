import { describe, expect, it } from 'vitest';
import {
  builderAxis,
  builderSort,
  builderIssue,
  builderOrderFields,
  editableBuilder,
  filterValueType,
  typedFilterValue,
  newBuilderQuery,
} from './builder';
import { setQueryLanguage } from './tileEditing';
import { sqlQuery } from './tiles';
import type { DashboardTile } from '../../lib/types';
const tile = (): DashboardTile => ({
  tile_id: 'test',
  tileType: 'builder',
  chartType: 'bar',
  dbName: ['logs'],
  chartQuery: newBuilderQuery(),
});

it('clears or migrates legacy x-axis sorting without losing unrelated metadata', () => {
  const draft = {
    ...tile(),
    chartQuery: {
      ...newBuilderQuery(),
      x: { fields: [], sortBy: { field: 'COUNT_STAR', direction: 'DESC' }, future: true },
    },
  };
  expect(sqlQuery(draft)).toContain('ORDER BY "COUNT_STAR" DESC');
  const cleared = { ...draft, ...builderSort(draft) };
  expect(sqlQuery(cleared)).not.toContain('ORDER BY');
  expect(cleared.chartQuery.x.future).toBe(true);
  const changed = { ...draft, ...builderSort(draft, { field: 'COUNT_STAR', direction: 'ASC' }) };
  expect(sqlQuery(changed)).toContain('ORDER BY "COUNT_STAR" ASC');
});
it('permits unlimited queries and ignores hidden row limits for scalar charts', () => {
  const draft = { ...tile(), ...builderAxis(tile(), 'y', { limit: undefined }) };
  expect(builderIssue(draft)).toBe('');
  expect(sqlQuery(draft)).not.toContain('LIMIT');
  for (const chartType of ['gauge', 'query-value']) {
    const scalar = { ...draft, chartType, ...builderAxis(draft, 'y', { limit: NaN }) };
    expect(builderIssue(scalar)).toBe('');
    expect(sqlQuery(scalar)).not.toContain('LIMIT');
  }
});
describe('visual builder', () => {
  it('executes dimensions, aggregates, grouping and filters with quoted identifiers and values', () => {
    const draft = {
      ...tile(),
      chartQuery: {
        x: { fields: [{ name: 'service' }] },
        y: {
          fields: [{ name: 'duration', aggregate: 'AVG' }],
          groupBy: ['host'],
          sortBy: { field: 'duration', direction: 'DESC' },
          limit: 20,
        },
        filters: [{ column: 'message', operator: '=', value: "it's fine" }],
      },
    };
    expect(sqlQuery(draft)).toContain('AVG("duration") AS "AVG_duration"');
    expect(sqlQuery(draft)).toContain("'it''s fine'");
    expect(sqlQuery(draft)).toContain('GROUP BY "service", "host"');
    expect(sqlQuery(draft)).toContain('ORDER BY "AVG_duration" DESC LIMIT 20');
  });
  it('preserves extension properties and the other axis when changing fields', () => {
    const draft = {
      ...tile(),
      chartQuery: {
        ...newBuilderQuery(),
        extension: { keep: true },
        y: { ...newBuilderQuery().y, extra: 42 },
      },
    };
    expect(builderAxis(draft, 'y', { limit: 5 }).chartQuery).toEqual({
      ...draft.chartQuery,
      y: { ...draft.chartQuery.y, limit: 5 },
    });
  });
  it('keeps stored SQL and complex legacy filters out of visual edits', () => {
    expect(editableBuilder({ ...tile(), chartQuery: { sql: 'SELECT 1', opaque: true } })).toBe(
      false,
    );
    expect(
      editableBuilder({
        ...tile(),
        chartQuery: {
          ...newBuilderQuery(),
          filters: [{ column: 'host', operator: '=', value: ['a', 'b'] }],
        },
      }),
    ).toBe(false);
  });
  it('retains dataset when changing modes and converts builder SQL faithfully', () => {
    const draft = tile();
    expect(setQueryLanguage(draft, 'code').chartQuery).toBe(sqlQuery(draft));
    expect(
      setQueryLanguage({ ...draft, tileType: 'code', chartQuery: 'SELECT 1' }, 'builder').dbName,
    ).toEqual(['logs']);
    expect(editableBuilder(draft)).toBe(true);
  });
});

describe('builder field choices', () => {
  it('offers projected dimensions and aggregate aliases without projecting unrelated order columns', () => {
    const draft = {
      ...tile(),
      chartQuery: {
        x: { fields: [{ name: 'service' }] },
        y: {
          fields: [
            { name: 'duration', aggregate: 'AVG' },
            { name: '*', aggregate: 'COUNT' },
          ],
          groupBy: ['host'],
          sortBy: { field: 'AVG_duration', direction: 'DESC' },
        },
      },
    };
    expect(builderOrderFields(draft)).toEqual(['service', 'host', 'AVG_duration', 'COUNT_STAR']);
    expect(sqlQuery(draft)).toContain('ORDER BY "AVG_duration" DESC');
    expect(builderIssue(draft)).toBe('');
    expect(
      builderIssue({
        ...draft,
        chartQuery: {
          ...draft.chartQuery,
          y: { ...draft.chartQuery.y, sortBy: { field: 'message', direction: 'ASC' } },
        },
      }),
    ).toContain('order field');
  });
  it('uses time_bucket rather than the raw timestamp for time-series order choices', () => {
    const draft = {
      ...tile(),
      chartType: 'timeseries',
      chartQuery: {
        ...newBuilderQuery(),
        x: { fields: [{ name: 'p_timestamp' }, { name: 'service' }] },
      },
    };
    expect(builderOrderFields(draft)).toEqual(['time_bucket', 'service', 'COUNT_STAR']);
  });
  it('detects stale dimensions, group fields and filters after a dataset changes without mutating the query', () => {
    const draft = {
      ...tile(),
      chartQuery: {
        ...newBuilderQuery(),
        x: { fields: [{ name: 'old_service' }] },
        y: { ...newBuilderQuery().y, groupBy: ['old_host'] },
        filters: [{ column: 'old_message', operator: '=', value: 'error' }],
      },
    };
    const before = structuredClone(draft);
    expect(builderIssue(draft, ['p_timestamp', 'message'])).toBe(
      'Choose fields available in this dataset: old_service, old_host, old_message.',
    );
    expect(builderIssue(draft)).toBe('');
    expect(draft).toEqual(before);
  });
  it('keeps independent group selections intact and detects an aggregate without a valid input field', () => {
    const draft = { ...tile(), ...builderAxis(tile(), 'y', { groupBy: ['service', 'host'] }) };
    expect(sqlQuery(draft)).toContain('GROUP BY "service", "host"');
    expect(
      builderIssue({
        ...draft,
        ...builderAxis(draft, 'y', { fields: [{ name: '*', aggregate: 'SUM' }] }),
      }),
    ).toContain('Choose a field');
  });
});

it('creates a default time-series visual query with a projected time bucket', () => {
  const draft = setQueryLanguage(
    { ...tile(), tileType: 'code', chartType: 'timeseries', chartQuery: '' },
    'builder',
  );
  const sql = sqlQuery(draft);
  expect(sql).toContain('DATE_TRUNC(\'minute\', "p_timestamp") AS "time_bucket"');
  expect(sql).toContain('GROUP BY "time_bucket" ORDER BY "time_bucket" DESC');
  expect(setQueryLanguage(draft, 'code').chartQuery).toBe(sql);
});

it('treats omitted tileType as builder and preserves it on no-op selection', () => {
  const draft = tile();
  delete draft.tileType;
  expect(setQueryLanguage(draft, 'builder')).toBe(draft);
  expect(setQueryLanguage(draft, 'code').chartQuery).toBe(sqlQuery(draft));
});
it('preserves native numeric and boolean filter values through visual edits', () => {
  expect(filterValueType(2)).toBe('number');
  expect(filterValueType(false)).toBe('boolean');
  expect(typedFilterValue('2.5', 'number')).toBe(2.5);
  expect(typedFilterValue('false', 'boolean')).toBe(false);
  const draft = {
    ...tile(),
    chartQuery: {
      ...newBuilderQuery(),
      filters: [
        { column: 'duration', operator: '>=', value: typedFilterValue('2.5', 'number') },
        { column: 'success', operator: '=', value: typedFilterValue('true', 'boolean') },
      ],
    },
  };
  expect(sqlQuery(draft)).toContain('"duration" >= 2.5 AND "success" = true');
});
it('reports invalid numeric filters and row limits specifically, permitting null predicates', () => {
  expect(builderIssue({ ...tile(), ...builderAxis(tile(), 'y', { limit: NaN }) })).toContain(
    'whole row limit',
  );
  expect(builderIssue({ ...tile(), ...builderAxis(tile(), 'y', { limit: 1.5 }) })).toContain(
    'whole row limit',
  );
  const draft = {
    ...tile(),
    chartQuery: {
      ...newBuilderQuery(),
      filters: [{ column: 'duration', operator: '=', value: typedFilterValue('', 'number') }],
    },
  };
  expect(builderIssue(draft)).toContain('finite number');
  expect(
    builderIssue({
      ...draft,
      chartQuery: {
        ...draft.chartQuery,
        filters: [{ column: 'duration', operator: 'IS NULL', value: NaN }],
      },
    }),
  ).toBe('');
});
