import { describe, expect, it } from 'vitest';
import { createQueryTab, datasetQuery, hydrateQueryTabs } from './workspace';
describe('SQL workspace identity hydration', () => {
  it('preserves distinct live tabs with identical SQL, including their results and metadata', () => {
    const first = createQueryTab('First', 'SELECT 1');
    const second = createQueryTab('Second', 'SELECT 1');
    first.rows = [{ value: 1 }];
    second.rows = [{ value: 2 }];
    second.view = 'chart';
    expect(hydrateQueryTabs([], [first, second], new Set())).toEqual([first, second]);
  });
  it('consumes each restored draft once and keeps unmatched stored drafts', () => {
    const stored = createQueryTab('Stored', 'SELECT 1');
    stored.savedId = 'saved-query';
    stored.datasets = ['events'];
    stored.columns = ['b', 'a'];
    stored.columnFields = ['a', 'hidden', 'b'];
    const other = createQueryTab('Other stored draft', 'SELECT 2');
    const first = createQueryTab('URL placeholder', 'SELECT 1');
    first.rows = [{ value: 1 }];
    const second = createQueryTab('Second live tab', 'SELECT 1');
    const result = hydrateQueryTabs([stored, other], [first, second], new Set());
    expect(result).toEqual([
      other,
      {
        ...first,
        name: stored.name,
        savedId: stored.savedId,
        datasets: stored.datasets,
        chart: stored.chart,
        columns: stored.columns,
        columnFields: stored.columnFields,
      },
      second,
    ]);
    expect(result[1].id).toBe(first.id);
    expect(result[1].rows).toBe(first.rows);
  });
  it('matches duplicate stored drafts one to one and preserves explicit live edits', () => {
    const stored = createQueryTab('Stored one', 'SELECT 1');
    stored.savedId = 'saved-one';
    const duplicate = createQueryTab('Stored two', 'SELECT 1');
    duplicate.savedId = 'saved-two';
    const edited = createQueryTab('Renamed live tab', 'SELECT 1');
    edited.datasets = ['audit'];
    const pristine = createQueryTab('URL placeholder', 'SELECT 1');
    expect(hydrateQueryTabs([stored, duplicate], [edited, pristine], new Set([edited.id]))).toEqual(
      [
        { ...edited, savedId: stored.savedId },
        {
          ...pristine,
          name: duplicate.name,
          savedId: duplicate.savedId,
          datasets: duplicate.datasets,
          chart: duplicate.chart,
        },
      ],
    );
  });
});
describe('SQL dataset source generation', () => {
  it('quotes identifier contents rather than treating selected names as SQL', () => {
    expect(datasetQuery(['events"archive'])).toContain('FROM "events""archive"');
  });
  it('applies ordering and the row limit to the combined selection', () => {
    const query = datasetQuery(['events', 'audit']);
    expect(query).toBe(
      'SELECT * FROM (\nSELECT * FROM "events"\nUNION ALL BY NAME\nSELECT * FROM "audit"\n) AS combined\nORDER BY "p_timestamp" DESC\nLIMIT 100',
    );
    expect(datasetQuery([])).toBe('');
  });
});
