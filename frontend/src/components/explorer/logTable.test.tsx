import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DataTable } from './DataTable';
import { VirtualLogTable } from './VirtualLogTable';
import { columnLabel, formatValue, orderLogRows } from './logTable';
import { LogHistogram } from './LogHistogram';
import { formatTimestamp } from './timezone';

describe('log table presentation', () => {
  it('sorts numeric values without mutating query rows', () => {
    const rows = [{ value: 10 }, { value: 2 }, { value: 1 }];
    expect(
      orderLogRows(rows, { field: 'value', descending: false }).map((row) => row.value),
    ).toEqual([1, 2, 10]);
    expect(
      orderLogRows(rows, { field: 'value', descending: true }).map((row) => row.value),
    ).toEqual([10, 2, 1]);
    expect(rows.map((row) => row.value)).toEqual([10, 2, 1]);
    expect(orderLogRows(rows)).toBe(rows);
    expect(
      orderLogRows([{ value: 'item10' }, { value: 'item2' }], {
        field: 'value',
        descending: false,
      })[0].value,
    ).toBe('item2');
  });
  it('labels the selected timestamp and preserves value formatting', () => {
    expect(columnLabel('p_timestamp', 'p_timestamp', 'UTC', true)).toBe('Ingestion Time (UTC)');
    expect(columnLabel('event_time', 'event_time', 'America/Chicago', true)).toBe(
      'Timestamp (America/Chicago)',
    );
    expect(formatValue(null)).toBe('—');
    expect(formatValue({ key: 1 })).toBe('{"key":1}');
  });
  it.each([DataTable, VirtualLogTable])(
    'renders severity, messages and summary fields consistently',
    (Table) => {
      const markup = renderToStaticMarkup(
        <Table
          rows={[{ level: 'ERROR', message: 'failed', service: 'api' }]}
          columns={['level', 'message']}
          summary
        />,
      );
      expect(markup).toContain('data-tone="danger"');
      expect(markup).toContain('message-cell');
      expect(markup).toContain('log-data-key');
      expect(markup).toContain('service');
      expect(markup).toContain('api');
    },
  );
});

describe('aggregate histogram', () => {
  it('uses server bucket geometry for labels, axis and bucket count', () => {
    const start = Date.parse('2026-01-01T00:00:00Z');
    const interval = 120_000;
    const markup = renderToStaticMarkup(
      <LogHistogram
        aggregate={{
          bins: [1, 3, 0],
          total: 4,
          start,
          end: start + 3 * interval - 60_000,
          interval,
        }}
      />,
    );
    expect(markup).toContain('across 3 time buckets');
    expect(markup).toContain(`title="${formatTimestamp(start + interval, 'UTC')} · 3 events"`);
    expect(markup).toContain(formatTimestamp(start + 3 * interval - 60_000, 'UTC'));
    expect(markup).toContain('4 matching events');
    expect(markup).toContain('height:100%');
    expect(markup).toContain('height:0%;min-height:0');
  });
});
