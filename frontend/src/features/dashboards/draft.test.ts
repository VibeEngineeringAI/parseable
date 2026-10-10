import { describe, expect, it } from 'vitest';
import classic from './__fixtures__/classic.json';
import demoTile from './__fixtures__/ingest-demo-tile.json';
import {
  dashboardPayload,
  loadDraft,
  applyTile,
  applyVariable,
  removeVariable,
  variableNames,
} from './draft';
import {
  convertBuilder,
  setQueryLanguage,
  addPromqlQuery,
  removePromqlQuery,
  promqlRows,
} from './tileEditing';
import { knownTile, promqlQueries, sqlQuery, tileStep } from './tiles';
import { ulid } from '../../lib/dashboardsContract';
import { classicTimeRange } from './timeRange';
import type { DashboardVariable } from '../../lib/types';

describe('production dashboard draft and save payload', () => {
  it('round-trips the loaded full classic document through tile editing and the save payload', () => {
    const loaded = loadDraft(classic).draft;
    const edited = applyTile(loaded, { ...loaded.tiles![0], title: 'Edited' });
    const expected = structuredClone(classic);
    expected.tiles[0].title = 'Edited';
    expect(dashboardPayload(edited, '1h', false)).toEqual(expected);
    expect(classic.tiles[0].title).toBe('Host load');
    const { timeRange: _range, ...withoutRange } = classic;
    expect(dashboardPayload(withoutRange, '30m', false)).toEqual({
      ...withoutRange,
      timeRange: classicTimeRange('30m', undefined),
    });
    expect(
      dashboardPayload(
        { ...classic, timeRange: { ...classic.timeRange, futureRange: 7 } },
        '30m',
        true,
      ).timeRange,
    ).toEqual({
      ...classicTimeRange('30m', undefined),
      futureRange: 7,
    });
  });
  it('repairs duplicate and nil ids before editing, without touching the first id or extras', () => {
    const input = {
      ...classic,
      tiles: [
        classic.tiles[0],
        { ...classic.tiles[0], title: 'Second' },
        { ...classic.tiles[1], tile_id: '00000000000000000000000000' },
      ],
    };
    const { draft, repaired } = loadDraft(input);
    expect(repaired).toBe(2);
    expect(draft.tiles![0]).toBe(input.tiles[0]);
    expect(new Set(draft.tiles!.map((tile) => tile.tile_id)).size).toBe(3);
    expect(
      draft.tiles!.every(
        (tile) => ulid(tile.tile_id) && tile.tile_id !== '00000000000000000000000000',
      ),
    ).toBe(true);
    expect(draft.tiles![1]).toEqual({ ...input.tiles[1], tile_id: expect.any(String) });
    const edited = applyTile(draft, { ...draft.tiles![1], title: 'Only second' });
    expect(edited.tiles!.map((tile) => tile.title)).toEqual(['Host load', 'Only second', 'Errors']);
    expect(input.tiles[1].tile_id).toBe(input.tiles[0].tile_id);
  });
  it('reads the ingest_demo_data.sh fixture as a builder and converts its exact classic aliases', () => {
    expect(demoTile).not.toHaveProperty('tileType');
    expect(knownTile(demoTile)).toBe(true);
    const sql =
      'SELECT DATE_TRUNC(\'minute\', "p_timestamp") AS "time_bucket", COUNT("severity_number") AS "COUNT_severity_number", "severity_text" AS "severity_text" FROM "demodata" GROUP BY "time_bucket", "severity_text" ORDER BY "time_bucket" DESC';
    expect(sqlQuery(demoTile)).toBe(sql);
    expect(convertBuilder(demoTile)).toEqual({
      ...demoTile,
      tileType: 'code',
      chartQuery: sql,
      dbName: ['demodata'],
    });
    expect(demoTile.chartQuery.y.fields[0].aggregate).toBe('COUNT');
  });
  it.each([
    { ...demoTile, dbName: [] },
    { ...demoTile, chartQuery: { y: { fields: [{ name: 'x', aggregate: 'MYSTERY' }] } } },
    {
      ...demoTile,
      chartQuery: {
        ...demoTile.chartQuery,
        filters: [{ column: 'x', operator: 'mystery', value: 1 }],
      },
    },
  ])('blocks builder conversion when it cannot preserve query semantics', (tile) => {
    expect(() => convertBuilder(tile)).toThrow('cannot be converted faithfully');
  });
  it('removes recognized old-language fields while keeping unknown tile data', () => {
    const source = {
      ...classic.tiles[0],
      promqlStep: '30s',
      promqlQuery: { query: 'up' },
      unknownQuery: { keep: true },
    };
    const sql = setQueryLanguage(source, 'code');
    expect(sql).toEqual(
      Object.fromEntries(
        Object.entries({ ...source, tileType: 'code', chartQuery: '', dbName: [] }).filter(
          ([key]) => !['promqlStep', 'promqlQuery', 'promqlQueryType'].includes(key),
        ),
      ),
    );
    expect(removePromqlQuery(addPromqlQuery(source), 0)).toEqual({
      ...source,
      chartQuery: [''],
      promqlQueryType: ['range'],
    });
  });
  it.each([
    { tile_id: 'x', tileType: 'promql', chartQuery: { query: 'up', step: '5m', type: 'instant' } },
    { tile_id: 'x', tileType: 'promql', promqlQuery: { query: 'up', step: '5m', type: 'instant' } },
  ])('keeps a legacy PromQL step and query type through every edit path', (tile) => {
    const rows = promqlQueries(tile);
    const edits = [
      { ...tile, ...promqlRows(tile, [{ ...rows[0], query: 'up + 1' }]) },
      { ...tile, ...promqlRows(tile, [{ ...rows[0], type: 'both' }]) },
      addPromqlQuery(tile),
      removePromqlQuery(addPromqlQuery(tile), 1),
      removePromqlQuery({ ...tile, ...promqlRows(tile, [...rows, ...rows]) }, 0),
      setQueryLanguage(tile, 'promql'),
    ];
    expect(tileStep(tile, 0, 3600, 'up')).toBe('5m');
    for (const edited of edits) expect(tileStep(edited, 0, 3600, 'up')).toBe('5m');
    expect(edits.map((edited) => promqlQueries(edited))).toEqual([
      [{ query: 'up + 1', type: 'instant' }],
      [{ query: 'up', type: 'both' }],
      [
        { query: 'up', type: 'instant' },
        { query: '', type: 'range' },
      ],
      [{ query: 'up', type: 'instant' }],
      [{ query: 'up', type: 'instant' }],
      [{ query: 'up', type: 'instant' }],
    ]);
    expect(promqlRows({ tile_id: 'x', chartQuery: ['up'] }, rows)).not.toHaveProperty('promqlStep');
  });
  it('converts classic scalar filters, sorting and limits without dropping their semantics', () => {
    const tile = {
      ...demoTile,
      chartType: 'bar',
      chartQuery: {
        x: { fields: [{ name: 'service' }] },
        y: {
          fields: [{ name: 'All rows (*)', aggregate: 'count' }],
          sortBy: { field: 'All rows (*)', direction: 'DESC' },
          limit: 20,
        },
        filters: [
          { column: 'severity', operator: '=', value: [1, '1', 2], type: 'number' },
          { column: 'host', operator: '!=', value: null, type: 'text' },
        ],
      },
    };
    expect(convertBuilder(tile).chartQuery).toBe(
      'SELECT "service" AS "service", COUNT(*) AS "COUNT_STAR" FROM "demodata" WHERE ("severity" = 1 OR "severity" = 2) AND "host" IS NOT NULL GROUP BY "service" ORDER BY "COUNT_STAR" DESC LIMIT 20',
    );
  });
  it('matches classic stat grouping/first aggregate and blocks malformed grouping', () => {
    const tile = {
      ...demoTile,
      chartType: 'query-value',
      chartQuery: {
        x: { groupBy: ['host'] },
        y: {
          fields: [
            { name: 'service', aggregate: 'count(distinct)' },
            { name: 'duration', aggregate: 'avg' },
          ],
          limit: 2,
        },
      },
    };
    expect(convertBuilder(tile).chartQuery).toBe(
      'SELECT "host" AS "host", COUNT(DISTINCT "service") AS "COUNT(DISTINCT)_service" FROM "demodata" GROUP BY "host"',
    );
    expect(() =>
      convertBuilder({ ...tile, chartQuery: { ...tile.chartQuery, x: { groupBy: [1] } } }),
    ).toThrow('cannot be converted faithfully');
  });
});

describe('variable editing on the stored document', () => {
  const host: DashboardVariable = { name: 'host', label: 'Host', type: 'list', options: ['a'] };
  const hidden = { name: 'host', label: 'Classic host', type: 'mystery', sqlQuery: '$host' };
  const region = { name: 'region', label: 'Region', type: 'list', defaultValue: 3 };
  const base = { ...classic, tiles: [], variables: [hidden, host, region] };

  it('reserves hidden names and edits or deletes only the readable row', () => {
    expect(variableNames(base)).toEqual(['host', 'host', 'region']);
    const edited = applyVariable(base, { ...host, label: 'Edited' }, host);
    expect(edited.variables).toEqual([hidden, { ...host, label: 'Edited' }, region]);
    expect(removeVariable(base, host).variables).toEqual([hidden, region]);
    const added: DashboardVariable = { name: 'level', label: 'Level', type: 'text' };
    expect(applyVariable(base, added).variables).toEqual([hidden, host, region, added]);
  });

  it('rewrites whole $name and ${name} tokens when a variable is renamed', () => {
    const sql = {
      tile_id: '01HZ0000000000000000000001',
      tileType: 'code',
      chartQuery: `SELECT * FROM "$host" WHERE h = '\${host}' AND n = $hostname`,
      dbName: ['$host'],
    };
    const promql = {
      tile_id: '01HZ0000000000000000000002',
      tileType: 'promql',
      chartQuery: ['up{host="$host"}', 'up{host=~"${host}|$hostname"}'],
      dbName: '${host}',
    };
    const legacy = {
      tile_id: '01HZ0000000000000000000003',
      chartQuery: { query: 'SELECT $host' },
      dbName: ['logs'],
    };
    const others: DashboardVariable[] = [
      { name: 'q', label: 'Q', type: 'sql', sqlQuery: "SELECT x WHERE h = '$host'" },
      {
        name: 'p',
        label: 'P',
        type: 'promql_query',
        promqlQuery: 'up{host="${host}"}',
        promqlQueryDataset: '$host',
      },
      {
        name: 'l',
        label: 'L',
        type: 'promql',
        dataset: '$host',
        labelName: 'job',
        labelFilters: [{ label: 'host', operator: '=', value: '$host' }],
      },
    ];
    const draft = {
      ...classic,
      tiles: [sql, promql, legacy],
      variables: [host, ...others, { ...hidden, name: 'old' }],
    };
    const renamed = applyVariable(draft, { ...host, name: 'node' }, host);
    expect(renamed.tiles).toEqual([
      {
        ...sql,
        chartQuery: `SELECT * FROM "$node" WHERE h = '\${node}' AND n = $hostname`,
        dbName: ['$node'],
      },
      {
        ...promql,
        chartQuery: ['up{host="$node"}', 'up{host=~"${node}|$hostname"}'],
        dbName: '${node}',
      },
      legacy,
    ]);
    expect(renamed.tiles![2]).toBe(legacy);
    expect(renamed.variables).toEqual([
      { ...host, name: 'node' },
      { ...others[0], sqlQuery: "SELECT x WHERE h = '$node'" },
      { ...others[1], promqlQuery: 'up{host="${node}"}', promqlQueryDataset: '$node' },
      {
        ...others[2],
        dataset: '$node',
        labelFilters: [{ label: 'host', operator: '=', value: '$node' }],
      },
      { ...hidden, name: 'old' },
    ]);
  });

  it('leaves references alone when another stored row still defines the old name', () => {
    const tile = { tile_id: '01HZ0000000000000000000001', tileType: 'code', chartQuery: '$host' };
    const renamed = applyVariable({ ...base, tiles: [tile] }, { ...host, name: 'node' }, host);
    expect(renamed.tiles).toEqual([tile]);
    expect(renamed.variables).toEqual([hidden, { ...host, name: 'node' }, region]);
  });
});
