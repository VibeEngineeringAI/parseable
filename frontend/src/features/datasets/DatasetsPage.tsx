import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { Database, ArrowUpRight, Search, RefreshCw, Plus } from 'lucide-react';
import { Badge, Button, Card, Input, EmptyState, Select } from '../../components/ui';
import { PageHeader } from '../../components/explorer/PageHeader';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { CreateDatasetDialog } from './CreateDatasetDialog';
import { ManageDatasetSheet } from './ManageDatasetSheet';
import './datasets.css';
import { forgetMetricsDatasets } from '../../lib/metrics';
import { datasetPath, listDatasetInventory } from '../../lib/datasetPath';
export function DatasetsPage() {
  const { client } = useApp();
  const data = useAsync(useCallback((signal) => listDatasetInventory(client, signal), [client]));
  const [search, setSearch] = useState('');
  const [type, setType] = useState('all');
  const [selected, setSelected] = useState<string>();
  const [creating, setCreating] = useState(false);
  const datasets =
    data.data?.filter(
      (d) =>
        (type === 'all' || (type === 'unknown' ? !d.type : d.type === type)) &&
        [d.name, ...(d.info?.datasetTags ?? []), ...(d.info?.datasetLabels ?? [])].some((value) =>
          value.toLowerCase().includes(search.toLowerCase()),
        ),
    ) || [];
  return (
    <div className="page datasets-page">
      <PageHeader
        title="Datasets"
        description="Queryable containers where your logs, metrics, or traces live."

        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                forgetMetricsDatasets(client);
                data.reload();
              }}
            >
              <RefreshCw size={15} aria-hidden="true" />
              Refresh
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={15} aria-hidden="true" />
              Create dataset
            </Button>
          </>
        }
      />
      <div className="list-toolbar">
        <div className="search-field">
          <Search size={16} />
          <Input
            aria-label="Search datasets"
            placeholder="Search by name, tag or label…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select label="Dataset type" value={type} onChange={(event) => setType(event.target.value)}>
          <option value="all">All types</option>
          <option value="logs">Logs</option>
          <option value="metrics">Metrics</option>
          <option value="traces">Traces</option>
          <option value="unknown">Type unavailable</option>
        </Select>
        <span className="muted">{datasets.length} datasets</span>
      </div>
      <QueryState loading={data.loading} error={data.error} retry={data.reload} />
      <Card className="dataset-table">
        <div className="table-scroll">
          <table>
            <caption className="sr-only">Datasets</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Type</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {datasets.map((d) => (
                <tr key={d.name}>
                  <td>
                    {d.type ? (
                      <Link className="dataset-name" to={datasetPath(d)}>
                        <Database size={15} />
                        {d.name}
                      </Link>
                    ) : (
                      <strong className="dataset-name">{d.name}</strong>
                    )}
                  </td>
                  <td>
                    <Badge>{d.type ?? 'Type unavailable'}</Badge>
                    {d.info?.datasetTags?.length ? (
                      <p className="muted">Tags: {d.info.datasetTags.join(', ')}</p>
                    ) : null}
                    {d.info?.datasetLabels?.length ? (
                      <p className="muted">Labels: {d.info.datasetLabels.join(', ')}</p>
                    ) : null}
                    {d.typeError && <p className="muted">{d.typeError}</p>}
                  </td>
                  <td>
                    <div className="inline">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelected(d.name)}
                        aria-label={`Manage ${d.name}`}
                      >
                        Manage
                      </Button>
                      {d.type ? (
                        <Link className="text-link" to={datasetPath(d)}>
                          Explore <ArrowUpRight size={14} />
                        </Link>
                      ) : (
                        <span className="muted">Explore unavailable</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {!data.loading && !data.error && !datasets.length && (
        <EmptyState
          title="No datasets found"
          description="Change your search or create a dataset."
        />
      )}
      {creating && (
        <CreateDatasetDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setSearch('');
            setType('all');
            data.reload();
          }}
        />
      )}
      {selected && (
        <ManageDatasetSheet
          key={selected}
          dataset={selected}
          onClose={() => setSelected(undefined)}
          onDeleted={data.reload}
        />
      )}
    </div>
  );
}
