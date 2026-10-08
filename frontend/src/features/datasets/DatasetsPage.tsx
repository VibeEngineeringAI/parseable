import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { Database, ArrowUpRight, Search, RefreshCw } from 'lucide-react';
import { Badge, Button, Card, Input, Sheet, EmptyState } from '../../components/ui';
import { PageHeader } from '../../components/explorer/PageHeader';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
function DatasetSchema({ dataset }: { dataset: string }) {
  const { client } = useApp();
  const schema = useAsync(
    useCallback((signal) => client.schema(dataset, signal), [client, dataset]),
  );
  return (
    <>
      <QueryState loading={schema.loading} error={schema.error} retry={schema.reload} />
      <div className="schema-list">
        {schema.data?.map((field) => (
          <div key={field} data-field-node={field}>
            <code>{field}</code>
            <Badge>field</Badge>
          </div>
        ))}
      </div>
      <Link className="text-link" to={`/logs/explore/${encodeURIComponent(dataset)}`}>
        Explore dataset <ArrowUpRight size={14} />
      </Link>
    </>
  );
}
export function DatasetsPage() {
  const { client } = useApp();
  const data = useAsync(useCallback((signal) => client.listDatasets(signal), [client]));
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string>();
  const datasets =
    data.data?.filter((d) => d.name.toLowerCase().includes(search.toLowerCase())) || [];
  return (
    <div className="page">
      <PageHeader
        title="Datasets"
        description="Queryable containers where your logs, metrics, or traces live."

        actions={
          <Button variant="secondary" onClick={data.reload}>
            <RefreshCw size={15} />
            Refresh
          </Button>
        }
      />
      <div className="list-toolbar">
        <div className="search-field">
          <Search size={16} />
          <Input
            aria-label="Search datasets"
            placeholder="Search by name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
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
                    <Link
                      className="dataset-name"
                      to={`/logs/explore/${encodeURIComponent(d.name)}`}
                    >
                      <Database size={15} />
                      {d.name}
                    </Link>
                  </td>
                  <td>
                    <Badge>{d.type}</Badge>
                  </td>
                  <td>
                    <div className="inline">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelected(d.name)}
                        aria-label={`View schema for ${d.name}`}
                      >
                        View schema
                      </Button>
                      <Link
                        className="text-link"
                        to={`/logs/explore/${encodeURIComponent(d.name)}`}
                      >
                        Explore <ArrowUpRight size={14} />
                      </Link>
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
          description="Change your search or ingest data into your server."
        />
      )}
      <Sheet
        open={!!selected}
        onOpenChange={(v) => {
          if (!v) setSelected(undefined);
        }}
        title={selected || 'Dataset'}
        description="Fields available in this dataset."
      >
        {selected && <DatasetSchema dataset={selected} />}
      </Sheet>
    </div>
  );
}
