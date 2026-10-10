import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, Star, ArrowDown, ArrowUp } from 'lucide-react';
import {
  ActionsMenu,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Pagination,
  PAGE_SIZE,
  Select,
  Tabs,
} from '../../components/ui';
import type { DashboardSummary } from '../../lib/types';
import { useRowDeletionFocus } from '../../hooks/useRowDeletionFocus';
import { dashboardDate, filterDashboards, type DashboardSort } from './helpers';

export function DashboardsList({
  rows,
  refreshing,
  owner,
  isAdmin,
  deleted,
  onAction,
}: {
  rows: DashboardSummary[];
  refreshing: boolean;
  owner?: string;
  isAdmin: boolean;
  deleted?: string;
  onAction: (
    action: 'rename' | 'duplicate' | 'delete' | 'favourite' | 'export',
    row: DashboardSummary,
  ) => void;
}) {
  const [search, setSearch] = useState(''),
    [tab, setTab] = useState('all'),
    [tag, setTag] = useState('');
  const [sort, setSort] = useState<DashboardSort>('title'),
    [descending, setDescending] = useState(false),
    [requestedPage, setPage] = useState(0);
  const filtered = filterDashboards(rows, { search, tab, tag, sort, descending, owner });
  const page = Math.min(requestedPage, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  const focus = useRowDeletionFocus(
    rows.map((row) => row.dashboardId),
    refreshing,
  );
  useEffect(() => {
    if (deleted) focus.onDeleted(deleted);
  }, [deleted]);
  const date = (value?: string | null) => {
    const iso = dashboardDate(value);
    return iso ? (
      <time dateTime={iso}>{new Date(iso).toLocaleString()}</time>
    ) : (
      <span className="muted">—</span>
    );
  };
  const content = !filtered.length ? (
    <EmptyState
      title={rows.length ? 'No matching dashboards' : 'No dashboards yet'}
      description={
        rows.length
          ? 'Try another title, tab or tag.'
          : 'Create a dashboard to visualize logs and metrics.'
      }
    />
  ) : (
    <Card className="dashboards-list" aria-busy={refreshing}>
      <table>
        <caption className="sr-only">Dashboards</caption>
        <thead>
          <tr>
            {(['title', 'modified', 'created'] as DashboardSort[]).map((key) => (
              <th
                key={key}
                scope="col"
                aria-sort={sort === key ? (descending ? 'descending' : 'ascending') : 'none'}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSort(key);
                    setDescending(sort === key ? !descending : false);
                    setPage(0);
                  }}
                >
                  {key === 'title' ? 'Title and tags' : key === 'modified' ? 'Updated' : 'Created'}
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
            const owned = !!owner && row.author === owner;
            return (
              <tr key={row.dashboardId}>
                <td className="dashboards-title">
                  <div className="inline">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${row.isFavorite ? 'Unfavourite' : 'Favourite'} ${row.title}`}
                      aria-pressed={!!row.isFavorite}
                      disabled={!owned || refreshing}
                      title={owned ? undefined : 'Only the owner can change favourites.'}
                      onClick={() => onAction('favourite', row)}
                    >
                      <Star
                        size={16}
                        fill={row.isFavorite ? 'currentColor' : 'none'}
                        aria-hidden="true"
                      />
                    </Button>
                    <Link to={`/dashboards/${encodeURIComponent(row.dashboardId)}`}>
                      {row.title}
                    </Link>
                  </div>
                  <div className="dashboards-tags">
                    {[...new Set(row.tags ?? [])].map((value) => (
                      <Badge key={value}>{value}</Badge>
                    ))}
                  </div>
                  {typeof row.description === 'string' && (
                    <p className="muted">{row.description}</p>
                  )}
                </td>
                <td className="dashboards-date">
                  <span className="dashboards-mobile-label">Updated: </span>
                  {date(row.modified)}
                </td>
                <td className="dashboards-date">
                  <span className="dashboards-mobile-label">Created: </span>
                  {date(row.created)}
                </td>
                <td className="dashboards-row-actions">
                  <ActionsMenu
                    label={`Actions for ${row.title}`}
                    data-row-action={row.dashboardId}
                    disabled={refreshing}
                    items={[
                      ...(owned
                        ? [
                            {
                              id: 'rename',
                              label: 'Rename and tags',
                              onSelect: () => onAction('rename', row),
                            },
                          ]
                        : []),
                      {
                        id: 'duplicate',
                        label: 'Duplicate',
                        onSelect: () => onAction('duplicate', row),
                      },
                      {
                        id: 'export',
                        label: 'Export JSON',
                        onSelect: () => onAction('export', row),
                      },
                      ...(owned || isAdmin
                        ? [
                            {
                              id: 'delete',
                              label: 'Delete',
                              destructive: true,
                              onSelect: () => onAction('delete', row),
                            },
                          ]
                        : []),
                    ]}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Pagination page={page} total={filtered.length} noun="dashboards" onPageChange={setPage} />
    </Card>
  );
  return (
    <section ref={focus.root} className="stack" aria-label="Dashboards list">
      <div className="list-toolbar dashboards-toolbar">
        <div className="search-field">
          <Search size={16} aria-hidden="true" />
          <Input
            data-list-search
            aria-label="Search dashboards"
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
          {[...new Set(rows.flatMap((row) => row.tags ?? []))].sort().map((value) => (
            <option key={value}>{value}</option>
          ))}
        </Select>
        <Select
          aria-label="Sort dashboards"
          value={sort}
          onChange={(event) => {
            setSort(event.target.value as DashboardSort);
            setPage(0);
          }}
        >
          <option value="title">Title</option>
          <option value="modified">Updated</option>
          <option value="created">Created</option>
        </Select>
        <Button
          size="sm"
          onClick={() => setDescending(!descending)}
          aria-label="Reverse sort order"
        >
          {descending ? 'Descending' : 'Ascending'}
        </Button>
      </div>
      <Tabs
        aria-label="Dashboard filter"
        value={tab}
        onValueChange={(value) => {
          setTab(value);
          setPage(0);
        }}
        items={[
          { value: 'all', label: 'All', content },
          { value: 'mine', label: 'Mine', content },
          { value: 'favourites', label: 'Favourites', content },
        ]}
      />
    </section>
  );
}
