import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, ArrowLeft, Search } from 'lucide-react';
import {
  ActionsMenu,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  PAGE_SIZE,
  Pagination,
  TypedConfirmDialog,
} from '../../components/ui';
import { PageHeader } from '../../components/explorer/PageHeader';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import type { AlertTarget } from '../../lib/types';
import { TargetSheet } from './TargetSheet';
import { targetType, targetTypeLabel } from './targetHelpers';
import { revealBesideStickyColumn, useAlertAccess } from './shared';
import { useRowDeletionFocus } from '../../hooks/useRowDeletionFocus';
import { useCollection } from '../../hooks/useCollection';
import { useMutation } from '../../hooks/useMutation';

export function TargetsPage() {
  const { client } = useApp(),
    canWrite = useAlertAccess();
  const targets = useCollection(useCallback((signal) => client.listAlertTargets(signal), [client]));
  const [search, setSearch] = useState(''),
    [status, setStatus] = useState(''),
    [creating, setCreating] = useState(false),
    [editing, setEditing] = useState<AlertTarget>(),
    [removing, setRemoving] = useState<AlertTarget>();
  const [sort, setSort] = useState<'name' | 'type' | 'endpoint' | 'status'>('name'),
    [descending, setDescending] = useState(false),
    [requestedPage, setPage] = useState(0);
  const mutation = useMutation();
  const filtered = (targets.data ?? [])
    .filter(({ target }) => target.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      const key = (row: typeof a) =>
        sort === 'status'
          ? row.enabled
            ? 'Enabled'
            : 'Disabled'
          : sort === 'type'
            ? targetTypeLabel(targetType(row.target))
            : row.target[sort];
      return (
        (key(a).localeCompare(key(b)) || a.target.id.localeCompare(b.target.id)) *
        (descending ? -1 : 1)
      );
    });
  const deletionFocus = useRowDeletionFocus(
    (targets.data ?? []).map(({ target }) => target.id),
    targets.loading,
  );
  const page = Math.min(requestedPage, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  return (
    <div ref={deletionFocus.root} className="page alerts-page stack">
      <Link className="alerts-back" to="/alerts">
        <ArrowLeft size={14} aria-hidden="true" /> Back to alerts
      </Link>
      <PageHeader
        title="Alert targets"
        description="Manage notification destinations. Endpoints and secrets are masked by the server."
        actions={
          canWrite && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New target
            </Button>
          )
        }
      />
      <div className="list-toolbar alerts-toolbar">
        <div className="search-field">
          <Search size={16} aria-hidden="true" />
          <Input
            data-list-search
            aria-label="Search targets"
            placeholder="Search by name"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
          />
        </div>
      </div>
      <QueryState
        loading={targets.loading && !targets.data}
        error={targets.error}
        retry={targets.reload}
      />
      <p role="status" className="muted alerts-status">
        {status || (targets.loading && targets.data ? 'Refreshing targets…' : '')}
      </p>
      {targets.data &&
        (!targets.data.length ? (
          <EmptyState
            title="No targets yet"
            description="Create a destination to receive alert notifications."
            action={
              canWrite && (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  New target
                </Button>
              )
            }
          />
        ) : !filtered.length ? (
          <EmptyState title="No matching targets" description="Try another name." />
        ) : (
          <Card className="alerts-table" aria-busy={targets.loading}>
            <p className="alerts-scroll-hint muted">Scroll horizontally for more columns.</p>
            <div
              className="table-scroll"
              role="region"
              aria-label="Targets table"
              tabIndex={0}
              onFocus={revealBesideStickyColumn}
            >
              <table>
                <caption className="sr-only">Alert targets</caption>
                <thead>
                  <tr>
                    {(['name', 'type', 'endpoint', 'status'] as const).map((key) => (
                      <th
                        key={key}
                        scope="col"
                        aria-sort={
                          sort === key ? (descending ? 'descending' : 'ascending') : 'none'
                        }
                      >
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Sort by ${key}`}
                          onClick={() => {
                            if (sort === key) setDescending(!descending);
                            else {
                              setSort(key);
                              setDescending(false);
                            }
                            setPage(0);
                          }}
                        >
                          {key[0].toUpperCase() + key.slice(1)}
                          {sort === key &&
                            (descending ? (
                              <ArrowDown size={12} aria-hidden="true" />
                            ) : (
                              <ArrowUp size={12} aria-hidden="true" />
                            ))}
                        </Button>
                      </th>
                    ))}
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered
                    .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
                    .map(({ target, enabled, error }) => (
                      <tr key={target.id}>
                        <td>{target.name}</td>
                        <td>{targetTypeLabel(targetType(target))}</td>
                        <td>{target.endpoint}</td>
                        <td>
                          <Badge tone={enabled ? 'success' : 'warning'}>
                            {enabled ? 'Enabled' : 'Disabled'}
                          </Badge>
                          {error && <p className="alerts-policy-error muted">{error}</p>}
                        </td>
                        <td>
                          {canWrite ? (
                            <ActionsMenu
                              label={`Actions for ${target.name}`}
                              data-row-action={target.id}
                              items={[
                                {
                                  id: 'edit',
                                  label: 'Edit',
                                  onSelect: () => setEditing(target),
                                  disabled: mutation.pending,
                                },
                                {
                                  id: 'delete',
                                  label: 'Delete',
                                  destructive: true,
                                  disabled: mutation.pending,
                                  onSelect: () => {
                                    mutation.reset();
                                    setRemoving(target);
                                  },
                                },
                              ]}
                            />
                          ) : (
                            <span className="muted">Read-only</span>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} total={filtered.length} noun="targets" onPageChange={setPage} />
          </Card>
        ))}
      {(creating || editing) && (
        <TargetSheet
          target={editing}
          onClose={() => {
            setCreating(false);
            setEditing(undefined);
          }}
          onSaved={(target) => {
            setStatus(`${target.name}: Target ${editing ? 'saved' : 'created'}.`);
            targets.reload();
          }}
        />
      )}
      {removing && (
        <TypedConfirmDialog
          open
          title="Delete target"
          name={removing.name}
          action="Delete target"
          pending={mutation.pending}
          error={mutation.error}
          onOpenChange={(open) => {
            if (!open) setRemoving(undefined);
          }}
          onConfirm={() => {
            void mutation.run(async () => {
              await client.deleteAlertTarget(removing.id);
              if (mutation.isActive()) {
                deletionFocus.onDeleted(removing.id);
                setRemoving(undefined);
                targets.reload();
              }
            });
          }}
        >
          <p className="muted">
            Targets referenced by an alert cannot be deleted. Remove them from the alert first.
          </p>
        </TypedConfirmDialog>
      )}
    </div>
  );
}
