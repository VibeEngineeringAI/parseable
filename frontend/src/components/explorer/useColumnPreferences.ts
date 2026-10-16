import { useContext, useState } from 'react';
import { AppContext } from '../../app/AppProvider';
import { columnStorageKey, readColumnOrder } from './columnOrder';

function read(key: string | null) {
  try {
    return key ? readColumnOrder(JSON.parse(localStorage.getItem(key) || 'null')) : undefined;
  } catch {
    return undefined;
  }
}

/** Writes only on explicit interaction, so opening a shared view never overwrites defaults. */
export function useColumnPreferences(table?: string) {
  const app = useContext(AppContext);
  const key = app && table ? columnStorageKey(app.mode, app.identity, table) : null;
  const [stored, setStored] = useState(() => ({ key, columns: read(key) }));
  if (stored.key !== key) setStored({ key, columns: read(key) });
  const columns = stored.key === key ? stored.columns : read(key);
  const setColumns = (columns: string[]) => {
    setStored({ key, columns });
    try {
      if (key) localStorage.setItem(key, JSON.stringify(columns));
    } catch {
      /* Ordering still works when browser storage is unavailable. */
    }
  };
  return [columns, setColumns] as const;
}
