import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, BellOff, Search } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  PAGE_SIZE,
  Pagination,
  Select,
} from '../../components/ui';
import type { AlertSummary } from '../../lib/types';
import { AlertActions } from './AlertActions';
import { useRowDeletionFocus } from '../../hooks/useRowDeletionFocus';
import { revealBesideStickyColumn } from './shared';
import {
  filterSortAlerts,
  muteState,
  alertTypeLabel,
  severityLabel,
  stateLabel,
  type AlertSort,
} from './helpers';

export function AlertsList({
  rows,
  refreshing,
  onChanged,
  canWrite,
}: {
  rows: AlertSummary[];
  refreshing: boolean;
  onChanged: () => void;
  canWrite: boolean;
}) {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState(''),
    [tag, setTag] = useState(''),
    [sort, setSort] = useState<AlertSort>('title'),
    [descending, setDescending] = useState(false),
    [requestedPage, setPage] = useState(0);
  const filtered = filterSortAlerts(rows, search, tag, sort, descending);
  const deletionFocus = useRowDeletionFocus(
    rows.map((row) => row.id),
    refreshing,
  );
  const page = Math.min(requestedPage, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  const tags = [...new Set(rows.flatMap((row) => row.tags ?? []))].sort();
  const columns: [AlertSort, string][] = [
    ['title', 'Title'],
    ['severity', 'Severity'],
    ['state', 'State'],
    ['type', 'Type'],
    ['dataset', 'Dataset'],
    ['tags', 'Tags'],
  ];
  return (
    <section ref={deletionFocus.root} aria-label="Alerts list" className="stack">
      <div className="list-toolbar alerts-toolbar">
        <div className="search-field">
          <Search size={16} aria-hidden="true" />
          <Input
            data-list-search
            aria-label="Search alerts"
            placeholder="Search by title"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
          />
        </div>
        <Select
          aria-label="Filter by tag"
          value={tag}
          onChange={(event) => {
            setTag(event.target.value);
            setPage(0);
          }}
        >
          <option value="">All tags</option>
          {tags.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
      </div>
      <p role="status" className="muted alerts-status">
        {status || (refreshing ? 'Refreshing alerts…' : '')}
      </p>
      {!rows.length ? (
        <EmptyState
          title="No alerts yet"
          description="Track thresholds in metrics and SQL query results."
          action={
            canWrite ? (
              <Link className="ui-button" data-variant="primary" to="/alerts/new">
                New alert
              </Link>
            ) : undefined
          }
        />
      ) : !filtered.length ? (
        <EmptyState title="No matching alerts" description="Try another title or tag." />
      ) : (
        <Card className="alerts-table alerts-list-table" aria-busy={refreshing}>
          <p className="alerts-scroll-hint muted">Scroll horizontally for more columns.</p>
          <div
            className="table-scroll"
            role="region"
            aria-label="Alerts table"
            tabIndex={0}
            onFocus={revealBesideStickyColumn}
          >
            <table>
              <caption className="sr-only">Alerts</caption>
              <thead>
                <tr>
                  {columns.map(([key, label]) => (
                    <th
                      key={key}
                      scope="col"
                      aria-sort={sort === key ? (descending ? 'descending' : 'ascending') : 'none'}
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Sort by ${label.toLowerCase()}`}
                        onClick={() => {
                          if (sort === key) setDescending(!descending);
                          else {
                            setSort(key);
                            setDescending(false);
                          }
                          setPage(0);
                        }}
                      >
                        {label}
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
                {filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((row) => {
                  const mute = muteState(row.notificationState);
                  const supported = row.alertType === 'threshold';
                  return (
                    <tr key={row.id}>
                      <td>
                        {supported ? (
                          <Link to={`/alerts/${encodeURIComponent(row.id)}`}>{row.title}</Link>
                        ) : (
                          <>
                            {row.title} <span className="muted">Not supported here</span>
                          </>
                        )}
                        {mute.muted && (
                          <span className="alerts-muted" title={mute.label}>
                            <BellOff size={13} aria-hidden="true" />
                            <span className="sr-only">{mute.label}</span>
                          </span>
                        )}
                      </td>
                      <td>
                        <Badge
                          tone={
                            row.severity === 'critical'
                              ? 'danger'
                              : row.severity === 'high'
                                ? 'warning'
                                : 'neutral'
                          }
                        >
                          {severityLabel(row.severity)}
                        </Badge>
                      </td>
                      <td>
                        <Badge
                          tone={
                            row.state === 'triggered'
                              ? 'danger'
                              : row.state === 'disabled'
                                ? 'neutral'
                                : 'success'
                          }
                        >
                          {stateLabel(row.state)}
                        </Badge>
                      </td>
                      <td>{alertTypeLabel(row)}</td>
                      <td>{row.datasets.join(', ')}</td>
                      <td>
                        <div className="alerts-tags">
                          {(row.tags ?? []).map((value) => (
                            <Badge key={value}>{value}</Badge>
                          ))}
                        </div>
                      </td>
                      <td>
                        <AlertActions
                          alert={row}
                          canWrite={canWrite}
                          onChanged={onChanged}
                          onDeleted={() => deletionFocus.onDeleted(row.id)}
                          onStatus={(message) => setStatus(`${row.title}: ${message}`)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination page={page} total={filtered.length} noun="alerts" onPageChange={setPage} />
        </Card>
      )}
    </section>
  );
}
