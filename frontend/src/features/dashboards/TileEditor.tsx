import { useCallback, useId, useMemo, useState } from 'react';
import { Button, Dialog, Input, Select } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import type { QueryLimiter } from '../../lib/concurrency';
import { timeBounds } from '../../lib/query';
import { loadTile } from './queries';
import { TileChart } from './TileChart';
import { useAsync } from '../../hooks/useAsync';
import { discoverMetricsDatasets } from '../../lib/metrics';
import { createPromqlMetadata } from '../../lib/promqlMetadata';
import type { DashboardTile, DashboardVariable } from '../../lib/types';
import {
  newTile,
  promqlQueries,
  record,
  resolvedLayouts,
  sqlQuery,
  supportedCharts,
  text,
  tileDatasets,
  type QueryMode,
} from './tiles';
import { TileQueryFields } from './TileQueryFields';
import { TileAppearanceFields } from './TileAppearanceFields';
import { setQueryLanguage } from './tileEditing';
import { resolveDataset, type VariableValues } from './variables';

export function TileEditor({
  original,
  tiles,
  variables,
  values,
  limit,
  promqlEnabled,
  metadataEnabled,
  start,
  end,
  onClose,
  onApply,
  onDirty,
}: {
  original?: DashboardTile;
  tiles: DashboardTile[];
  variables: DashboardVariable[];
  values: VariableValues;
  limit: QueryLimiter;
  promqlEnabled?: boolean;
  metadataEnabled: boolean;
  start: number;
  end: number;
  onClose: () => void;
  onApply: (tile: DashboardTile) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const { client } = useApp();
  const [initial] = useState(() => original ?? newTile(tiles));
  const [draft, setDraft] = useState(() => structuredClone(initial));
  const [layoutValid, setLayoutValid] = useState(true);
  const [preview, setPreview] = useState<{ tile: DashboardTile; revision: number }>();
  const previewBounds = useMemo(
    () =>
      timeBounds({
        startTime: new Date(start * 1000).toISOString(),
        endTime: new Date(end * 1000).toISOString(),
      }),
    [start, end],
  );
  const previewResults = useAsync(
    useCallback(
      (signal) =>
        preview
          ? loadTile(client, preview.tile, variables, values, previewBounds, limit, signal)
          : Promise.resolve(undefined),
      [client, preview, variables, JSON.stringify(values), previewBounds, limit],
    ),
  );
  const runPreview = () =>
    setPreview((current) => ({
      tile: structuredClone(draft),
      revision: (current?.revision ?? 0) + 1,
    }));
  const reason = useId();
  const sql = useMemo(() => {
    try {
      return sqlQuery(draft);
    } catch {
      return '';
    }
  }, [draft.chartQuery, draft.dbName]);
  const queries = promqlQueries(draft),
    dataset = tileDatasets(draft)[0] ?? '',
    isPromql = draft.tileType === 'promql';
  const datasets = useAsync(useCallback((signal) => client.listDatasets(signal), [client]));
  const metrics = useAsync(
    useCallback(
      (signal) =>
        promqlEnabled && isPromql
          ? discoverMetricsDatasets(client, signal)
          : Promise.resolve({ datasets: [], unchecked: [] }),
      [client, promqlEnabled, isPromql],
    ),
  );
  const metadata = useMemo(
    () =>
      metadataEnabled
        ? createPromqlMetadata(client, resolveDataset(dataset, values), { start, end })
        : undefined,
    [client, dataset, JSON.stringify(values), start, end, metadataEnabled],
  );
  function change(edits: Partial<DashboardTile>) {
    setDraft((current) => ({ ...current, ...edits }));
    onDirty(true);
  }
  const validation = !layoutValid
    ? 'Enter a height between 1 and 24.'
    : !text(draft.title).trim()
      ? 'Enter a tile title.'
      : !dataset.trim()
        ? 'Choose a dataset.'
        : isPromql && !promqlEnabled
          ? promqlEnabled === undefined
            ? 'Loading server capabilities…'
            : 'PromQL dashboard tiles are unavailable on this server.'
          : isPromql
            ? !queries.length || queries.some((row) => !row.query.trim())
              ? 'Enter a PromQL query for every row.'
              : ''
            : !sql.trim()
              ? 'Enter a SQL query.'
              : '';
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={original ? 'Edit tile' : 'Add tile'}
      className="dashboard-tile-editor"
    >
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (validation) return;
          onDirty(false);
          onApply({
            ...draft,
            title: text(draft.title).trim(),
            ...(!isPromql ? { chartQuery: sql } : {}),
          });
        }}
      >
        <Input
          autoFocus
          label="Tile title"
          required
          value={text(draft.title)}
          onChange={(event) => change({ title: event.target.value })}
        />
        <Select
          label="Query language"
          value={isPromql ? 'promql' : 'code'}
          onChange={(event) => {
            const tileType = event.target.value;
            setDraft((current) => setQueryLanguage(current, tileType as 'code' | 'promql'));
            onDirty(true);
          }}
        >
          <option value="code">SQL</option>
          <option value="promql" disabled={!promqlEnabled}>
            PromQL
            {promqlEnabled === undefined
              ? ' (loading capabilities…)'
              : promqlEnabled
                ? ''
                : ' (unavailable)'}
          </option>
        </Select>
        {promqlEnabled === undefined && <p className="muted">Loading server capabilities…</p>}
        <QueryState
          loading={isPromql ? metrics.loading : datasets.loading}
          error={isPromql ? metrics.error : datasets.error}
          retry={isPromql ? metrics.reload : datasets.reload}
        />
        <Select
          label="Dataset"
          value={dataset}
          onChange={(event) =>
            change({ dbName: isPromql ? event.target.value : [event.target.value] })
          }
        >
          <option value="">Select a dataset</option>
          {[
            ...new Set([
              ...(isPromql ? (metrics.data?.datasets ?? []) : (datasets.data ?? [])).map(
                (item) => item.name,
              ),
              ...variables
                .filter((variable) => variable.type === 'dataset')
                .map((variable) => `$${variable.name}`),
              ...(dataset ? [dataset] : []),
            ]),
          ].map((name) => (
            <option key={name}>{name}</option>
          ))}
        </Select>
        <TileQueryFields
          key={draft.tileType as string}
          draft={draft}
          sql={sql}
          change={change}
          metadata={metadata}
          runPreview={runPreview}
        />
        <Button
          onClick={runPreview}
          disabled={
            !dataset ||
            (isPromql
              ? !queries.length || queries.some((row) => !row.query.trim()) || !promqlEnabled
              : !sql.trim())
          }
        >
          Run query
        </Button>
        {preview && (
          <div className="dashboard-preview">
            <h2>Preview</h2>
            <QueryState
              loading={previewResults.loading}
              error={previewResults.error}
              retry={previewResults.reload}
            />
            {previewResults.data && supportedCharts.includes(text(preview.tile.chartType)) && (
              <TileChart
                tile={preview.tile}
                result={previewResults.data}
                start={start}
                end={end}
                height={200}
              />
            )}
          </div>
        )}
        <TileAppearanceFields draft={draft} change={change} onValidity={setLayoutValid} />
        {draft.chartType === 'query-value' && (
          <p className="muted">
            Query value uses the first numeric column of the last row, unless the stored Y-axis
            field names a column. PromQL uses its Value column.
          </p>
        )}
        <p id={reason} className="muted">
          {validation}
        </p>
        <div className="dialog-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            data-dialog-confirm
            disabled={!!validation}
            aria-describedby={reason}
          >
            {original ? 'Apply tile' : 'Add tile'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
