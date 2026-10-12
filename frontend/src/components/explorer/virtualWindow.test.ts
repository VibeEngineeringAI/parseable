import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { VirtualLogTable } from './VirtualLogTable';
import { virtualWindow } from './virtualWindow';

describe('virtual result windows', () => {
  it('keeps a real summary-named field and formats custom partition timestamps', () => {
    const html = renderToStaticMarkup(
      createElement(VirtualLogTable, {
        rows: [
          {
            __summary__: 'actual field value',
            event_time: '2026-10-07T14:00:44Z',
            message: 'extra summary data',
          },
        ],
        columns: ['__summary__', 'event_time'],
        summary: true,
        timestampField: 'event_time',
        timezone: 'America/Chicago',
      }),
    );
    expect(html).toContain('actual field value');
    expect(html).toContain('Sort __summary__');
    expect(html).toContain('message=extra summary data');
    expect(html).toContain('Timestamp (America/Chicago)');
    expect(html).not.toContain('2026-10-07T14:00:44Z');
  });
  it('bounds row and column work independently of dataset size', () => {
    expect(virtualWindow(100_000, 38 * 1000, 480, 38, 6)).toEqual({ start: 994, end: 1019 });
    expect(virtualWindow(2000, 240 * 100, 960, 240, 2)).toEqual({ start: 98, end: 106 });
    expect(virtualWindow(2, 10000, 480, 38)).toEqual({ start: 2, end: 2 });
    expect(virtualWindow(0, 0, 480, 38)).toEqual({ start: 0, end: 0 });
  });
  it('renders only viewport rows and selected columns with accessible positions', () => {
    const rows = Array.from({ length: 10000 }, (_, index) => ({ message: `Event ${index}` }));
    const columns = Array.from({ length: 500 }, (_, index) => `field_${index}`);
    const html = renderToStaticMarkup(
      createElement(VirtualLogTable, { rows, columns, onSelect: () => {} }),
    );
    expect((html.match(/data-index=/g) ?? []).length).toBeLessThan(25);
    expect((html.match(/role="columnheader"/g) ?? []).length).toBeLessThan(10);
    expect(html).toContain('aria-rowcount="10001"');
    expect(html).toContain('aria-colcount="501"');
    expect(html).toContain('Open event 1');
    expect(html).not.toContain('field_499');
  });
  it('documents fixed expanded wrapping and formats timestamps in the chosen zone', () => {
    const html = renderToStaticMarkup(
      createElement(VirtualLogTable, {
        rows: [{ p_timestamp: '2026-10-07T14:00:44Z' }],
        wrap: true,
        timezone: 'America/Chicago',
      }),
    );
    expect(html).toContain('Timestamp (America/Chicago)');
    expect(html).toContain('height:96px');
    expect(html).toContain('Open an event for full values.');
  });
});
