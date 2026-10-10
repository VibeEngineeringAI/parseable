import { useEffect, useRef, useState, type SetStateAction } from 'react';
import { useApp } from '../../app/AppProvider';
import { useLeaveGuard } from '../../hooks/useLeaveGuard';
import { useMutation } from '../../hooks/useMutation';
import type { Dashboard, TimeRange } from '../../lib/types';
import { dashboardPayload, loadDraft } from './draft';
import { checkDashboardConflict } from './helpers';
import { dashboardRange } from './timeRange';

export function useDashboardDraft(original: Dashboard, focusHeading: () => void) {
  const { client } = useApp(),
    mutation = useMutation();
  const [loaded, setLoaded] = useState(original),
    [repair] = useState(() => loadDraft(original));
  const [repaired, setRepaired] = useState(repair.repaired);
  const [draft, setDraft] = useState(repair.draft),
    [rangeDirty, setRangeDirty] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false),
    [conflict, setConflict] = useState<Dashboard>();
  const [status, setStatus] = useState('');
  const read = useRef<AbortController | undefined>(undefined),
    announcement = useRef(0);
  useEffect(
    () => () => {
      read.current?.abort();
      cancelAnimationFrame(announcement.current);
    },
    [],
  );
  const dirty = JSON.stringify(draft) !== JSON.stringify(loaded) || rangeDirty;
  const markSaved = useLeaveGuard(dirty || editorDirty, 'dashboard');
  useEffect(() => {
    if (dirty && status === 'Dashboard saved.') setStatus('');
  }, [dirty, status]);
  function announce(message: string) {
    cancelAnimationFrame(announcement.current);
    setStatus('');
    announcement.current = requestAnimationFrame(() => setStatus(message));
  }
  function changeDraft(next: SetStateAction<Dashboard>, message?: string) {
    setStatus('');
    setDraft(next);
    if (message) announce(message);
  }
  function accept(document: Dashboard, message: string) {
    const next = loadDraft(document);
    setRepaired(next.repaired);
    setLoaded(document);
    setDraft(next.draft);
    setRangeDirty(false);
    setConflict(undefined);
    mutation.reset();
    markSaved();
    announce(message);
    focusHeading();
  }
  function save(range: TimeRange, overwrite = false) {
    void mutation.run(async () => {
      read.current?.abort();
      read.current = new AbortController();
      if (!overwrite) {
        const latest = await checkDashboardConflict(client, loaded, read.current.signal);
        if (!mutation.isActive()) return;
        if (latest) {
          setConflict(latest);
          return;
        }
      }
      const saved = await client.updateDashboard(
        draft.dashboardId,
        dashboardPayload(draft, range, rangeDirty),
      );
      if (mutation.isActive()) accept(saved, 'Dashboard saved.');
    });
  }
  return {
    draft,
    loaded,
    dirty,
    repaired,
    rangeDirty,
    setRangeDirty,
    editorDirty,
    setEditorDirty,
    conflict,
    setConflict,
    mutation,
    markSaved,
    status,
    announce,
    changeDraft,
    save,
    discard: () => accept(loaded, 'Changes discarded.'),
    reload: () => {
      if (conflict) accept(conflict, 'Loaded the server copy.');
    },
    storedRange: () => dashboardRange(new URLSearchParams(), (conflict ?? loaded).timeRange),
  };
}
