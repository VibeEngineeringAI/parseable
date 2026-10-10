import { useState } from 'react';
import { Button, Dialog } from '../../components/ui';
import { useApp } from '../../app/AppProvider';
import { useMutation } from '../../hooks/useMutation';
import { InlineError } from '../../components/ui';
import { loadDashboards } from './storage';
import {
  markerKey,
  planLocalImport,
  readImportMarker,
  runLocalImport,
  type ImportMarker,
  type LocalImportResult,
} from './importLocal';
export function LocalImportNotice({
  identity,
  titles,
  onImported,
}: {
  identity: string;
  titles: string[];
  onImported: () => void;
}) {
  const { client } = useApp(),
    mutation = useMutation();
  const [local, setLocal] = useState(() => loadDashboards('parseable-dashboards-v1-live'));
  const [marker, setMarker] = useState(() => readImportMarker(identity)),
    [results, setResults] = useState<LocalImportResult[]>();
  const [skipped, setSkipped] = useState(0);
  const [removing, setRemoving] = useState(false),
    [storageError, setStorageError] = useState<string>();
  const plan = planLocalImport(local, titles, marker.importedIds);
  if (!local.length || marker.dismissed) return null;
  function remember(next: ImportMarker) {
    try {
      localStorage.setItem(markerKey(identity), JSON.stringify(next));
      setMarker(next);
      setStorageError(undefined);
    } catch {
      setMarker(next);
      setStorageError(
        'Could not record the import status in browser storage. Local copies are still available.',
      );
    }
  }
  return (
    <div className="notice dashboard-local-notice">
      <div role="status">
        {plan.create.length
          ? `${plan.create.length} dashboards are saved only in this browser. Import them to your server account?`
          : 'Your browser-local dashboards have been imported. Local copies are still available.'}
        {results && (
          <p>
            {results.filter((result) => result.imported).length} imported · {skipped} previously
            imported · {results.filter((result) => !result.imported).length} failed
          </p>
        )}
      </div>
      <div className="inline wrap">
        {!!plan.create.length && (
          <Button
            variant="primary"
            disabled={mutation.pending}
            onClick={() =>
              void mutation.run(async () => {
                const result = await runLocalImport(
                  plan.create,
                  (body) => client.createDashboard(body),
                  titles,
                );
                const next = {
                  importedIds: [
                    ...new Set([
                      ...marker.importedIds,
                      ...result.filter((item) => item.imported).map((item) => item.id),
                    ]),
                  ],
                };
                // Persist successful IDs even if the user has left while the authorized imports finish.
                try {
                  localStorage.setItem(markerKey(identity), JSON.stringify(next));
                } catch {
                  if (mutation.isActive())
                    setStorageError(
                      'Could not record the import status in browser storage. Local copies are still available.',
                    );
                }
                if (mutation.isActive()) {
                  setMarker(next);
                  setSkipped(plan.skip.length);
                  setResults(result);
                  onImported();
                }
              })
            }
          >
            {mutation.pending ? 'Importing…' : 'Import local dashboards'}
          </Button>
        )}
        {!!plan.create.length && (
          <Button
            disabled={mutation.pending}
            onClick={() => remember({ ...marker, dismissed: true })}
          >
            Not now
          </Button>
        )}
        {!plan.create.length && (
          <Button onClick={() => setRemoving(true)}>Remove local copies</Button>
        )}
      </div>
      {results
        ?.filter((result) => !result.imported)
        .map((result) => (
          <p role="alert" key={result.id} className="error-text">
            {result.title}: {result.error}
          </p>
        ))}
      <InlineError error={storageError ?? mutation.error} />
      <Dialog
        open={removing}
        onOpenChange={setRemoving}
        title="Remove local copies?"
        description="Remove the old dashboards from this browser. Your imported server dashboards will stay available."
      >
        <div className="stack">
          <InlineError error={storageError} />
          <div className="dialog-actions">
            <Button onClick={() => setRemoving(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                try {
                  localStorage.removeItem('parseable-dashboards-v1-live');
                  setLocal([]);
                  setRemoving(false);
                } catch {
                  setStorageError('Could not remove the local copies.');
                }
              }}
            >
              Remove local copies
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
