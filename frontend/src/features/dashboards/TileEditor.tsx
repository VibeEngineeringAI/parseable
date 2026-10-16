import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Button, Dialog, Input, SearchableSelect, Select } from '../../components/ui';
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
  tileType,
} from './tiles';
import { TileQueryFields } from './TileQueryFields';
import { TileAppearanceFields } from './TileAppearanceFields';
import { TileBindingFields } from './TileBindingFields';
import { chartIssues } from './chartPicker';
import { builderIssue } from './builder';
import { setQueryLanguage } from './tileEditing';
import { dashboardSections } from './sections';
import { resolveDataset, type VariableValues } from './variables';
import { datasetOptions } from './pickerOptions';

export function TileEditor({
  original,
  defaultDataset,
  sections,
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
  defaultDataset?: string;
  sections?: unknown;
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
  const [initial] = useState(() => original ?? newTile(tiles, defaultDataset));
  const [draft, setDraft] = useState(() => structuredClone(initial));
  const [invalidFields, setInvalidFields] = useState<Set<string>>(() => new Set());
  const onValidity = useCallback((key: string, valid: boolean) => {
    setInvalidFields((current) => {
      if (current.has(key) === !valid) return current;
      const next = new Set(current);
      if (valid) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
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
  const columns = useMemo(
    () => [
      ...new Set((previewResults.data?.rows ?? []).slice(0, 50).flatMap((row) => Object.keys(row))),
    ],
    [previewResults.data],
  );
  const runPreview = () =>
    setPreview((current) => ({
      tile: structuredClone(draft),
      revision: (current?.revision ?? 0) + 1,
    }));
  const reason = useId();
  const { sql, sqlError } = useMemo(() => {
    try {
      return { sql: sqlQuery(draft), sqlError: '' };
    } catch (error) {
      return {
        sql: '',
        sqlError: error instanceof Error ? error.message : 'Could not generate SQL.',
      };
    }
  }, [draft.chartQuery, draft.dbName, draft.chartType]);
  const queries = promqlQueries(draft),
    dataset = tileDatasets(draft)[0] ?? '',
    isPromql = tileType(draft) === 'promql';
  const schema = useAsync(
    useCallback(
      (signal) =>
        dataset && !isPromql
          ? client.schema(resolveDataset(dataset, values), signal)
          : Promise.resolve([]),
      [client, dataset, JSON.stringify(values), isPromql],
    ),
  );
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
  useEffect(() => {
    if (
      original ||
      !defaultDataset ||
      (isPromql && !metrics.data?.datasets.some((entry) => entry.name === defaultDataset))
    )
      return;
    setDraft((current) =>
      !tileDatasets(current).some(Boolean)
        ? {
            ...current,
            dbName: tileType(current) === 'promql' ? defaultDataset : [defaultDataset],
          }
        : current,
    );
  }, [original, isPromql, defaultDataset, metrics.data]);
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
  const queryChanged = JSON.stringify(draft.chartQuery) !== JSON.stringify(initial.chartQuery);
  const datasetChanged = dataset !== (tileDatasets(initial)[0] ?? '');
  const builderValidation =
    tileType(draft) === 'builder' &&
    (queryChanged || datasetChanged || draft.chartType !== initial.chartType)
      ? builderIssue(draft, datasetChanged && !schema.loading ? schema.data : undefined)
      : '';
  const issue = builderValidation || chartIssues(draft)[0];
  const validation = invalidFields.size
    ? invalidFields.has('height')
      ? 'Enter a height between 1 and 24.'
      : invalidFields.has('range')
        ? 'Enter numbers for the gauge range.'
        : 'Enter numbers for the gauge thresholds.'
    : issue
      ? issue
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
              : !sql.trim() &&
                  !(
                    original &&
                    tileType(draft) === 'builder' &&
                    !queryChanged &&
                    !datasetChanged &&
                    draft.chartType === initial.chartType
                  )
                ? tileType(draft) === 'builder'
                  ? sqlError || 'Complete the visual query fields.'
                  : 'Enter a SQL query.'
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
            ...(tileType(draft) === 'code' ? { chartQuery: sql } : {}),
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
          value={isPromql ? 'promql' : tileType(draft) === 'builder' ? 'builder' : 'code'}
          onChange={(event) => {
            const language = event.target.value;
            if (
              language === 'builder' &&
              tileType(draft) === 'code' &&
              sql.trim() &&
              !window.confirm('Replace this SQL query with a new visual query?')
            )
              return;
            setDraft((current) =>
              setQueryLanguage(current, language as 'code' | 'promql' | 'builder'),
            );
            onDirty(true);
          }}
        >
          <option value="builder">Visual builder</option>
          <option value="code" disabled={tileType(draft) === 'builder' && !sql.trim()}>
            SQL
          </option>
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
        <SearchableSelect
          label="Dataset"
          value={dataset}
          onValueChange={(value) => change({ dbName: isPromql ? value : [value] })}
          options={datasetOptions({
            choices: [
              ...(isPromql ? (metrics.data?.datasets ?? []) : (datasets.data ?? [])).map(
                (item) => item.name,
              ),
              ...variables
                .filter((variable) => variable.type === 'dataset')
                .map((variable) => `$${variable.name}`),
            ],
            selected: dataset,
            emptyLabel: 'No dataset',
            // Unchecked metrics datasets may still hold metrics, so they are not marked.
            loaded: isPromql
              ? !!promqlEnabled && !!metrics.data && !metrics.data.unchecked.includes(dataset)
              : !!datasets.data,
          })}
          loading={isPromql ? metrics.loading : datasets.loading}
          onRetry={isPromql ? metrics.reload : datasets.reload}
          error={
            (isPromql ? metrics.error : datasets.error)
              ? isPromql
                ? 'Could not discover metrics datasets.'
                : 'Could not load datasets.'
              : undefined
          }
        />
        <Select
          label="Section"
          value={text(draft.sectionId)}
          onChange={(event) => change({ sectionId: event.target.value || undefined })}
        >
          <option value="">Unsectioned</option>
          {dashboardSections(sections).map((section) => (
            <option key={text(section.sectionId)} value={text(section.sectionId)}>
              {text(section.title) || 'Untitled section'}
            </option>
          ))}
          {text(draft.sectionId) &&
            !(Array.isArray(sections) ? sections : []).some(
              (section) => text(record(section).sectionId) === text(draft.sectionId),
            ) && <option value={text(draft.sectionId)}>{text(draft.sectionId)}</option>}
        </Select>
        {tileType(draft) === 'builder' && (
          <QueryState loading={schema.loading} error={schema.error} retry={schema.reload} />
        )}
        <TileQueryFields
          key={tileType(draft)}
          draft={draft}
          fields={schema.data ?? []}
          sql={sql}
          change={change}
          metadata={metadata}
          runPreview={runPreview}
        />
        <Button
          onClick={runPreview}
          disabled={
            !dataset ||
            !!builderValidation ||
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
        <TileBindingFields draft={draft} change={change} columns={columns} />
        <TileAppearanceFields draft={draft} change={change} onValidity={onValidity} />
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
