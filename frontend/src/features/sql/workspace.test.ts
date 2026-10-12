import { describe, expect, it } from 'vitest';
import { datasetQuery } from './workspace';
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
