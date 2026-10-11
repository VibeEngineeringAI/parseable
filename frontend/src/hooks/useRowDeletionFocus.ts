import { useEffect, useRef, useState } from 'react';

/** Restore the position in a refreshed list only after the deleted row is gone. */
export function useRowDeletionFocus(ids: string[], refreshing: boolean) {
  const root = useRef<HTMLDivElement>(null);
  const [deleted, setDeleted] = useState<{ id: string; neighbours: string[] }>();
  function onDeleted(id: string) {
    const visible = Array.from(
      root.current?.querySelectorAll<HTMLElement>('[data-row-action]') ?? [],
    ).map((button) => button.dataset.rowAction!);
    const index = visible.indexOf(id);
    setDeleted({
      id,
      neighbours: [...visible.slice(index + 1), ...visible.slice(0, index).reverse()],
    });
  }
  useEffect(() => {
    if (!deleted || refreshing || ids.includes(deleted.id)) return;
    const frame = requestAnimationFrame(() => {
      const buttons = Array.from(
        root.current?.querySelectorAll<HTMLButtonElement>('[data-row-action]') ?? [],
      );
      const neighbour = deleted.neighbours
        .map((id) => buttons.find((button) => button.dataset.rowAction === id))
        .find((button) => button && !button.disabled);
      (
        neighbour ??
        buttons[0] ??
        root.current?.querySelector<HTMLElement>('[data-list-search]')
      )?.focus();
      setDeleted(undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [deleted, refreshing, ids.join('\n')]);
  return { root, onDeleted };
}
