import {
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { GripHorizontal, MoveDiagonal } from 'lucide-react';
import type { DashboardTile } from '../../lib/types';
import { compactLayouts, moveTile, updateTileLayout, type TileLayout } from './layout';
import { tileTitle } from './tiles';
import './dashboardLayout.css';

type Gesture = {
  id: string;
  mode: 'move' | 'resize';
  pointerId: number;
  clientX: number;
  clientY: number;
  column: number;
  row: number;
  layout: TileLayout;
  source: DashboardTile[];
  next: DashboardTile[];
};

const sameTiles = (a: DashboardTile[] | undefined, b: DashboardTile[]) =>
  !!a && a.length === b.length && a.every((tile, index) => tile === b[index]);

function gestureEdits(
  layout: TileLayout,
  mode: Gesture['mode'],
  dx: number,
  dy: number,
): Partial<TileLayout> {
  return mode === 'move'
    ? { ...(dx ? { x: layout.x + dx } : {}), ...(dy ? { y: layout.y + dy } : {}) }
    : { ...(dx ? { w: layout.w + dx } : {}), ...(dy ? { h: Math.min(24, layout.h + dy) } : {}) };
}

/** A section-local grid. Only completed gestures update the dashboard draft. */
export function DashboardTileGrid({
  tiles,
  writable,
  onLayoutChange,
  children,
}: {
  tiles: DashboardTile[];
  writable: boolean;
  onLayoutChange?: (tiles: DashboardTile[], message?: string) => void;
  children: (tile: DashboardTile, layout: TileLayout, index: number, count: number) => ReactNode;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | undefined>(undefined);
  const [preview, setPreview] = useState<{ source: DashboardTile[]; tiles: DashboardTile[] }>();
  const help = useId();
  const displayed = preview && sameTiles(preview.source, tiles) && writable ? preview.tiles : tiles;
  const rows = compactLayouts(displayed);
  const enabled = writable && !!onLayoutChange;
  function layoutMessage(id: string, next: DashboardTile[]) {
    const row = compactLayouts(next).find(({ tile }) => tile.tile_id === id);
    return row
      ? `${tileTitle(row.tile)}: column ${row.layout.x + 1}, row ${row.layout.y + 1}, width ${row.layout.w}, height ${row.layout.h}. Save to keep this change.`
      : undefined;
  }
  function start(event: PointerEvent<HTMLButtonElement>, id: string, mode: Gesture['mode']) {
    if (!enabled || event.button !== 0 || !event.isPrimary || !grid.current) return;
    const style = getComputedStyle(grid.current);
    // The narrow-screen layout is a stack rather than a 12-column grid.
    if (style.display !== 'grid') return;
    const layout = rows.find(({ tile }) => tile.tile_id === id)!.layout;
    const gap = parseFloat(style.columnGap) || 0;
    gesture.current = {
      id,
      mode,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      column: (grid.current.getBoundingClientRect().width + gap) / 12,
      row: (parseFloat(style.gridAutoRows) || 70) + (parseFloat(style.rowGap) || 0),
      layout,
      source: tiles,
      next: tiles,
    };
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (!sameTiles(active.source, tiles) || !enabled) {
      cancel();
      return;
    }
    const dx = Math.round((event.clientX - active.clientX) / active.column);
    const dy = Math.round((event.clientY - active.clientY) / active.row);
    active.next = updateTileLayout(
      active.source,
      active.id,
      gestureEdits(active.layout, active.mode, dx, dy),
    );
    setPreview({ source: active.source, tiles: active.next });
  }
  function cancel() {
    gesture.current = undefined;
    setPreview(undefined);
  }
  function finish(event: PointerEvent<HTMLButtonElement>) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    cancel();
    if (sameTiles(active.source, tiles) && enabled && active.next !== active.source) {
      onLayoutChange?.(active.next, layoutMessage(active.id, active.next));
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, id: string, mode: Gesture['mode']) {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
      return;
    }
    if (
      !enabled ||
      gesture.current ||
      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    )
      return;
    event.preventDefault();
    const layout = rows.find(({ tile }) => tile.tile_id === id)!.layout;
    const dx = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    const dy = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    const next =
      mode === 'move' && dy
        ? moveTile(tiles, id, dy as -1 | 1)
        : updateTileLayout(tiles, id, gestureEdits(layout, mode, dx, dy));
    if (next !== tiles) {
      onLayoutChange?.(next, layoutMessage(id, next));
    }
  }
  return (
    <>
      <p id={help} className="sr-only">
        Drag to move or resize. Use arrow keys on a handle. Up and Down on the move handle reorder
        tiles. Escape cancels dragging.
      </p>
      <div ref={grid} className="dashboard-server-grid dashboard-layout-grid">
        {rows.map(({ tile, layout }, index) => (
          <div
            key={tile.tile_id}
            className={`dashboard-layout-cell${enabled ? ' dashboard-layout-editable' : ''}`}
            style={{
              gridColumn: `${layout.x + 1} / span ${layout.w}`,
              gridRow: `${layout.y + 1} / span ${layout.h}`,
            }}
          >
            {children(tile, layout, index, rows.length)}
            {enabled &&
              (['move', 'resize'] as const).map((mode) => (
                <button
                  key={mode}
                  data-dashboard-edit-control
                  type="button"
                  className={`dashboard-layout-handle dashboard-layout-${mode}`}
                  aria-label={`${mode === 'move' ? 'Move' : 'Resize'} tile ${tileTitle(tile)}`}
                  aria-describedby={help}
                  title={
                    mode === 'move'
                      ? 'Drag to move; arrow keys also work'
                      : 'Drag to resize; arrow keys also work'
                  }
                  onPointerDown={(event) => start(event, tile.tile_id, mode)}
                  onPointerMove={move}
                  onPointerUp={finish}
                  onPointerCancel={cancel}
                  onLostPointerCapture={cancel}
                  onKeyDown={(event) => keyboard(event, tile.tile_id, mode)}
                >
                  {mode === 'move' ? (
                    <GripHorizontal size={16} aria-hidden="true" />
                  ) : (
                    <MoveDiagonal size={16} aria-hidden="true" />
                  )}
                </button>
              ))}
          </div>
        ))}
      </div>
    </>
  );
}
