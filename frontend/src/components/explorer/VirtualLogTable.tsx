import { ColumnReorderHandle, useColumnReorder } from './ColumnReorder';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Button, EmptyState } from '../ui';
import type { LogRecord } from '../../lib/types';
import {
  orderLogRows,
  columnLabel,
  cellText,
  cellClassName,
  LogCellContent,
  type LogTableSort,
} from './logTable';
import { virtualWindow } from './virtualWindow';
import './virtual-log-table.css';

const COLUMN_WIDTH = 240;
const DETAILS_WIDTH = 40;
const HEADER_HEIGHT = 36;
export function VirtualLogTable({
  rows,
  columns,
  onColumnsChange,
  onSelect,
  caption = 'Query results',
  wrap = false,
  summary = false,
  timezone = 'UTC',
  timestampField = 'p_timestamp',
}: {
  rows: LogRecord[];
  columns?: string[];
  onColumnsChange?: (columns: string[]) => void;
  onSelect?: (row: LogRecord) => void;
  caption?: string;
  wrap?: boolean;
  summary?: boolean;
  timezone?: string;
  timestampField?: string;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 960, height: 480 });
  const [sort, setSort] = useState<LogTableSort>();
  const [focusedRow, setFocusedRow] = useState<number>();
  const pendingFocus = useRef<number | undefined>(undefined);
  const fields = useMemo(() => columns ?? [...new Set(rows.flatMap(Object.keys))], [columns, rows]);
  const reorder = useColumnReorder(fields, onColumnsChange ?? (() => {}));
  const displayFields = useMemo(() => (summary ? [...fields, null] : fields), [fields, summary]);
  const ordered = useMemo(() => orderLogRows(rows, sort), [rows, sort]);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const measure = () =>
      setPosition({
        top: node.scrollTop,
        left: node.scrollLeft,
        width: node.clientWidth,
        height: node.clientHeight,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [rows.length]);
  const rowHeight = wrap ? 96 : 38;
  useLayoutEffect(() => {
    if (pendingFocus.current === undefined) return;
    viewport.current
      ?.querySelector<HTMLButtonElement>(`[data-event-button="${pendingFocus.current}"]`)
      ?.focus({ preventScroll: true });
    pendingFocus.current = undefined;
  }, [focusedRow, position.top]);
  const detailWidth = onSelect ? DETAILS_WIDTH : 0;
  const rowWindow = virtualWindow(
    rows.length,
    Math.max(0, position.top - HEADER_HEIGHT),
    position.height,
    rowHeight,
    6,
  );
  const columnWindow = virtualWindow(
    displayFields.length,
    Math.max(0, position.left - detailWidth),
    position.width,
    COLUMN_WIDTH,
    2,
  );
  const visibleFields = displayFields.slice(columnWindow.start, columnWindow.end);
  const visibleRows = virtualWindow(
    rows.length,
    Math.max(0, position.top),
    Math.max(0, position.height - HEADER_HEIGHT),
    rowHeight,
    0,
  );
  const rowIndices = Array.from(
    { length: rowWindow.end - rowWindow.start },
    (_, index) => rowWindow.start + index,
  );
  // A focused detail control stays mounted when pointer scrolling moves it off screen.
  if (focusedRow !== undefined && focusedRow < rows.length && !rowIndices.includes(focusedRow))
    rowIndices.push(focusedRow);
  const width = Math.max(position.width, detailWidth + displayFields.length * COLUMN_WIDTH);
  const label = (field: string | null) => columnLabel(field, timestampField, timezone, summary);
  if (!rows.length)
    return (
      <EmptyState
        title="No matching events"
        description="Try a wider time range or adjust your query."
      />
    );
  return (
    <div className="results-table virtual-log-table">
      <div role="status" className="sr-only">
        {reorder.announcement}
      </div>
      <div
        ref={viewport}
        className="virtual-log-viewport"
        tabIndex={0}
        aria-label={`${caption}. Scroll to view more rows and columns.`}
        onKeyDown={(event) => {
          if (
            !onSelect ||
            (event.target !== event.currentTarget &&
              !(
                event.target instanceof HTMLElement &&
                event.target.hasAttribute('data-event-button')
              ))
          )
            return;
          const current = focusedRow ?? visibleRows.start;
          const pageSize = Math.max(1, Math.floor((position.height - HEADER_HEIGHT) / rowHeight));
          const target =
            event.key === 'ArrowDown'
              ? current + 1
              : event.key === 'ArrowUp'
                ? current - 1
                : event.key === 'PageDown'
                  ? current + pageSize
                  : event.key === 'PageUp'
                    ? current - pageSize
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? rows.length - 1
                        : undefined;
          if (target === undefined) return;
          event.preventDefault();
          const index = Math.max(0, Math.min(rows.length - 1, target));
          const node = event.currentTarget;
          const top = index * rowHeight;
          if (top < node.scrollTop) node.scrollTop = top;
          else if (top + rowHeight > node.scrollTop + node.clientHeight - HEADER_HEIGHT)
            node.scrollTop = top + rowHeight - node.clientHeight + HEADER_HEIGHT;
          pendingFocus.current = index;
          setFocusedRow(index);
          setPosition((position) => ({ ...position, top: node.scrollTop }));
        }}
        onScroll={(event) => {
          const node = event.currentTarget;
          setPosition({
            top: node.scrollTop,
            left: node.scrollLeft,
            width: node.clientWidth,
            height: node.clientHeight,
          });
        }}
      >
        <div
          role="table"
          aria-label={caption}
          aria-rowcount={rows.length + 1}
          aria-colcount={displayFields.length + (onSelect ? 1 : 0)}
          style={{ width, height: HEADER_HEIGHT + rows.length * rowHeight }}
          className="virtual-log-canvas"
        >
          <div
            role="row"
            aria-rowindex={1}
            className="virtual-log-header"
            style={{ width, height: HEADER_HEIGHT }}
          >
            {onSelect && (
              <div role="columnheader" aria-colindex={1} className="virtual-log-details">
                <span className="sr-only">Details</span>
              </div>
            )}
            {visibleFields.map((field, index) => (
              <div
                role="columnheader"
                aria-label={label(field)}
                aria-colindex={columnWindow.start + index + 1 + (onSelect ? 1 : 0)}
                aria-sort={
                  sort?.field === field ? (sort.descending ? 'descending' : 'ascending') : 'none'
                }
                key={field === null ? 'summary' : `field:${field}`}
                {...(field !== null ? reorder.targetProps(field) : {})}
                className="virtual-log-cell"
                style={{
                  left: detailWidth + (columnWindow.start + index) * COLUMN_WIDTH,
                  width: COLUMN_WIDTH,
                }}
              >
                {field === null ? (
                  label(field)
                ) : (
                  <div className="reorderable-column-heading">
                    {onColumnsChange && <ColumnReorderHandle field={field} reorder={reorder} />}
                    <button
                      className="column-sort"
                      aria-label={`Sort ${field}`}
                      onClick={() => {
                        setSort({
                          field,
                          descending: sort?.field === field ? !sort.descending : false,
                        });
                        if (viewport.current) viewport.current.scrollTop = 0;
                        setPosition((current) => ({ ...current, top: 0 }));
                      }}
                    >
                      {label(field)} {sort?.field === field ? (sort.descending ? '↓' : '↑') : '↕'}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {rowIndices.map((rowIndex) => {
            const row = ordered[rowIndex];
            return (
              <div
                role="row"
                aria-rowindex={rowIndex + 2}
                key={rowIndex}
                data-index={rowIndex}
                className="virtual-log-row"
                style={{ top: HEADER_HEIGHT + rowIndex * rowHeight, height: rowHeight, width }}
              >
                {onSelect && (
                  <div role="cell" aria-colindex={1} className="virtual-log-details">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Open event ${rowIndex + 1}`}
                      data-event-button={rowIndex}
                      onFocus={() => setFocusedRow(rowIndex)}
                      onBlur={() => setFocusedRow(undefined)}
                      onClick={() => onSelect(row)}
                    >
                      <ChevronRight size={14} />
                    </Button>
                  </div>
                )}
                {visibleFields.map((field, columnIndex) => {
                  const value = cellText(row, field, fields, timestampField, timezone);
                  return (
                    <div
                      role="cell"
                      aria-colindex={columnWindow.start + columnIndex + 1 + (onSelect ? 1 : 0)}
                      key={columnWindow.start + columnIndex}
                      title={value}
                      className={`virtual-log-cell ${cellClassName(field)} ${wrap ? 'virtual-log-wrap' : ''}`}
                      style={{
                        left: detailWidth + (columnWindow.start + columnIndex) * COLUMN_WIDTH,
                        width: COLUMN_WIDTH,
                        height: rowHeight,
                      }}
                    >
                      <LogCellContent
                        row={row}
                        field={field}
                        fields={fields}
                        timestampField={timestampField}
                        timezone={timezone}
                      />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <footer className="table-footer">
        <span>
          {rows.length.toLocaleString()} rows · {visibleRows.start + 1}–{visibleRows.end}
        </span>
        <span>
          {wrap
            ? 'Wrapped rows show up to four lines. Open an event for full values.'
            : 'Scroll to view all rows and columns.'}{' '}
          Sorting applies to loaded rows.
          {onSelect && ' Use arrow keys, Page Up/Down, Home or End to move between events.'}
        </span>
      </footer>
    </div>
  );
}
