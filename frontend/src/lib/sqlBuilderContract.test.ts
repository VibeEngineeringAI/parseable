import { describe, expect, it } from 'vitest';
import { alert } from './alertsContract';
import { alertFixture } from './__fixtures__/alerts';
import {
  builderEditable,
  demoCompileSqlBuilder,
  newSqlBuilder,
  sqlBuilderConfig,
  sqlFieldType,
} from './sqlBuilderContract';
import { alertDraft, buildAlertPayload, validateAlert } from '../features/alerts/helpers';

const spec = {
  ...newSqlBuilder('app"logs'),
  filters: {
    operator: 'and' as const,
    conditionConfig: [
      { column: 'level', operator: '=' as const, value: "it's error", type: 'string' },
    ],
  },
  groupBy: ['service'],
};
describe('SQL builder v1', () => {
  it('strictly decodes the supported spec independently of alert decoding', () => {
    expect(sqlBuilderConfig(spec)).toBe(true);
    for (const builderConfig of [
      { kind: 'sql', version: 2 },
      { ...spec, extra: true },
      { ...spec, aggregate: { function: 'ratio' } },
      null,
    ]) {
      expect(sqlBuilderConfig(builderConfig)).toBe(false);
      expect(alert({ ...alertFixture, queryType: 'builder', builderConfig })).toBe(true);
    }
  });
  it.each([
    { groupBy: ['a', 'b', 'c', 'd'] },
    { groupBy: ['a', 'a'] },
    { groupBy: ['alert_value'] },
    { groupBy: ['p_timestamp'] },
    { aggregate: { function: 'sum' } },
    { filters: { operator: 'and', groups: [{}] } },
    {
      filters: {
        operator: 'and',
        conditionConfig: [{ column: 'value', operator: '=', type: 'float', value: '1e400' }],
      },
    },
    {
      filters: {
        operator: 'and',
        conditionConfig: [
          { column: 'value', operator: '=', type: 'int', value: '18446744073709551616' },
        ],
      },
    },
    {
      filters: {
        operator: 'and',
        conditionConfig: [{ column: 'flag', operator: '>', type: 'boolean', value: 'true' }],
      },
    },
    {
      filters: {
        operator: 'and',
        conditionConfig: [
          { column: 'time', operator: '=', type: 'timestamp', value: 'not-a-date' },
        ],
      },
    },
    {
      filters: {
        operator: 'and',
        conditionConfig: [
          { column: 'x', operator: 'is null', type: 'string', value: 'unexpected' },
        ],
      },
    },
    {
      filters: {
        operator: 'and',
        conditionConfig: [{ column: 'x', operator: '=', type: 'string', value: 'x'.repeat(1025) }],
      },
    },
    {
      filters: {
        operator: 'and',
        conditionConfig: Array.from({ length: 21 }, () => ({
          column: 'x',
          operator: '=',
          type: 'string',
          value: 'ok',
        })),
      },
    },
  ])('rejects invalid or unbounded drafts %#', (patch) =>
    expect(sqlBuilderConfig({ ...spec, ...patch })).toBe(false),
  );
  it('preserves exact u64 literal strings, typed nulls and nested groups', () =>
    expect(
      sqlBuilderConfig({
        ...spec,
        filters: {
          operator: 'and',
          conditionConfig: [
            { column: 'x', operator: '=', type: 'int', value: '18446744073709551615' },
          ],
          groups: [
            {
              operator: 'or',
              conditionConfig: [
                { column: 'flag', operator: 'is null', value: '', type: 'boolean' },
              ],
            },
          ],
        },
      }),
    ).toBe(true));
  it('gates builder editability on capability, server status and recognized specification', () => {
    const row = { queryType: 'builder', builderStatus: 'editable', builderConfig: spec };
    expect(builderEditable(row, true)).toBe(true);
    expect(builderEditable(row, false)).toBe(false);
    expect(builderEditable({ ...row, builderStatus: 'unsupported' }, true)).toBe(false);
  });
  it('builds spec payloads with an empty query and converts to SQL explicitly without reserved response fields', () => {
    const source = {
      ...alertFixture,
      queryType: 'builder' as const,
      builderConfig: spec,
      builderStatus: 'editable' as const,
      executionMode: 'owner' as const,
      sqlRuntime: { health: 'ok' as const, error: null, lastEvaluatedAt: null },
      customMetadata: { keep: 'yes' },
    };
    const draft = alertDraft(source),
      body = buildAlertPayload(draft, source);
    expect(body.query).toBe('');
    expect(body.builderConfig).toEqual(spec);
    expect(body.customMetadata).toEqual({ keep: 'yes' });
    expect(body).not.toHaveProperty('executionMode');
    expect(body).not.toHaveProperty('sqlRuntime');
    const code = buildAlertPayload(
      { ...draft, type: 'code', builderConfig: undefined, query: source.query },
      source,
    );
    expect(code.query).toBe(source.query);
    expect(code.queryType).toBe('code');
    expect(code).not.toHaveProperty('builderConfig');
  });
  it('validates builder schedule bounds while preserving legacy SQL frequency support', () => {
    const draft = {
      ...alertDraft({ ...alertFixture, queryType: 'builder', builderConfig: spec }),
      frequency: '1441',
      window: '31d',
    };
    expect(validateAlert(draft, true)).toMatchObject({
      frequency: 'Use 1–1440 whole minutes.',
      window: 'Evaluation window cannot exceed 30 days.',
    });
    expect(validateAlert({ ...draft, type: 'code' }, true).frequency).toBeUndefined();
  });
  it('quotes identifiers and literals in the demo compiler', () =>
    expect(demoCompileSqlBuilder(spec)).toBe(
      'SELECT "service", COUNT(*) AS "alert_value" FROM "app""logs" WHERE "level" = \'it\'\'s error\' GROUP BY "service"',
    ));
  it.each([
    ['Int64', 'int'],
    ['Float64', 'float'],
    ['Utf8', 'string'],
    ['Boolean', 'boolean'],
    [{ Timestamp: ['Millisecond', null] }, 'timestamp'],
    [{ Decimal128: [38, 2] }, 'float'],
    [{ List: { name: 'item', data_type: 'Utf8' } }, 'list'],
    [{ List: { name: 'item', data_type: { Struct: [] } } }, undefined],
    [
      { List: { name: 'item', data_type: { List: { name: 'nested', data_type: 'Utf8' } } } },
      undefined,
    ],
    [{ Decimal32: [9, 2] }, undefined],
    ['Binary', undefined],
  ])('derives filter types from Arrow %#', (dataType, type) =>
    expect(sqlFieldType({ name: 'x', dataType })).toBe(type),
  );
});

it('keeps safe execution-owner display response-only when saving', () => {
  const source = { ...alertFixture, executionOwner: 'Support engineer' };
  expect(alert(source)).toBe(true);
  expect(buildAlertPayload(alertDraft(source), source)).not.toHaveProperty('executionOwner');
  expect(alert({ ...source, executionOwner: 123 })).toBe(false);
});
