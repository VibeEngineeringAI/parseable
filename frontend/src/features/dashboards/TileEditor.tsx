import { useCallback, useId, useMemo, useState } from 'react';
import { Button, Dialog, Input, Select } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { PromqlEditor } from '../../components/promql/PromqlEditor';
import { SqlEditor } from '../sql/SqlEditor';
import { useApp } from '../../app/AppProvider';
import type { QueryLimiter } from '../../lib/concurrency';
import { timeBounds } from '../../lib/query';
import { createId } from '../../lib/ids';
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
  promqlEnabled: boolean;
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
  const [preview, setPreview] = useState<{ tile: DashboardTile; revision: number }>();
  const [queryIds, setQueryIds] = useState(() => promqlQueries(initial).map(() => createId()));
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
  const config = record(draft.config),
    layout = record(config.layout),
    axes = record(config.axes);
  const position = resolvedLayouts(
    original ? tiles.map((tile) => (tile.tile_id === draft.tile_id ? draft : tile)) : [draft],
  ).find(({ tile }) => tile.tile_id === draft.tile_id)!.layout;
  function change(edits: Partial<DashboardTile>) {
    setDraft((current) => ({ ...current, ...edits }));
    onDirty(true);
  }
  function configLayout(key: string, value: unknown) {
    change({ config: { ...config, layout: { ...layout, [key]: value } } });
  }
  function axisTitle(axis: 'x' | 'y', value: string) {
    change({
      config: { ...config, axes: { ...axes, [axis]: { ...record(axes[axis]), title: value } } },
    });
  }
  const validation = !text(draft.title).trim()
    ? 'Enter a tile title.'
    : !dataset.trim()
      ? 'Choose a dataset.'
      : isPromql && !promqlEnabled
        ? 'PromQL dashboard tiles are unavailable on this server.'
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
          onApply({ ...draft, title: text(draft.title).trim() });
        }}
      >
        <Input
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
            setQueryIds(tileType === 'promql' ? [createId()] : []);
            change({
              tileType,
              chartQuery: tileType === 'promql' ? [''] : '',
              dbName: tileType === 'promql' ? '' : [],
              ...(tileType === 'promql' ? { promqlQueryType: ['range'] } : {}),
            });
          }}
        >
          <option value="code">SQL</option>
          <option value="promql" disabled={!promqlEnabled}>
            PromQL{promqlEnabled ? '' : ' (unavailable)'}
          </option>
        </Select>
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
        {isPromql ? (
          <div className="stack">
            {queries.map((row, index) => (
              <div className="dashboard-query-row" key={queryIds[index]}>
                <PromqlEditor
                  label={`PromQL query ${String.fromCharCode(65 + index)}`}
                  value={row.query}
                  onChange={(query) =>
                    change({
                      chartQuery: queries.map((row, i) => (i === index ? query : row.query)),
                      promqlQueryType: queries.map((row) => row.type),
                    })
                  }
                  metadata={metadata}
                  onRun={runPreview}
                />
                <div className="inline wrap">
                  <Select
                    label={`Query ${String.fromCharCode(65 + index)} type`}
                    value={row.type}
                    onChange={(event) =>
                      change({
                        promqlQueryType: queries.map((row, i) =>
                          i === index ? (event.target.value as QueryMode) : row.type,
                        ),
                      })
                    }
                  >
                    <option value="range">Range</option>
                    <option value="instant">Instant</option>
                    <option value="both">Both</option>
                  </Select>
                  {queries.length > 1 && (
                    <Button
                      onClick={() => {
                        setQueryIds((ids) => ids.filter((_, i) => i !== index));
                        change({
                          chartQuery: queries.filter((_, i) => i !== index).map((row) => row.query),
                          promqlQueryType: queries
                            .filter((_, i) => i !== index)
                            .map((row) => row.type),
                        });
                      }}
                    >
                      Remove query {String.fromCharCode(65 + index)}
                    </Button>
                  )}
                </div>
              </div>
            ))}
            <Button
              onClick={() => {
                setQueryIds((ids) => [...ids, createId()]);
                change({
                  chartQuery: [...queries.map((row) => row.query), ''],
                  promqlQueryType: [...queries.map((row) => row.type), 'range'],
                });
              }}
            >
              Add query
            </Button>
          </div>
        ) : (
          <SqlEditor
            value={sql}
            onChange={(chartQuery) => change({ chartQuery })}
            onRun={runPreview}
          />
        )}
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
        <div className="dashboard-editor-grid">
          <Select
            label="Chart type"
            value={text(draft.chartType, 'timeseries')}
            onChange={(event) =>
              change({
                chartType: event.target.value,
                config: { ...config, type: event.target.value },
              })
            }
          >
            {!supportedCharts.includes(text(draft.chartType)) && (
              <option value={text(draft.chartType)}>{text(draft.chartType)} (preserved)</option>
            )}
            {supportedCharts.map((type) => (
              <option key={type} value={type}>
                {type === 'query-value' ? 'Query value' : type[0].toUpperCase() + type.slice(1)}
              </option>
            ))}
          </Select>
          <Select
            label="Width (columns)"
            value={position.w}
            onChange={(event) => {
              const w = Number(event.target.value);
              change({
                layout: {
                  ...record(draft.layout),
                  ...position,
                  w,
                  x: Math.min(position.x, 12 - w),
                },
              });
            }}
          >
            {![3, 4, 6, 8, 12].includes(position.w) && (
              <option value={position.w}>{position.w} (preserved)</option>
            )}
            {[3, 4, 6, 8, 12].map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </Select>
          <Input
            label="Height (rows)"
            type="number"
            min={1}
            max={24}
            value={position.h}
            onChange={(event) => {
              const h = Number(event.target.value);
              if (Number.isFinite(h))
                change({
                  layout: {
                    ...record(draft.layout),
                    ...position,
                    h: Math.min(24, Math.max(1, Math.floor(h))),
                  },
                });
            }}
          />
          <Input
            label="Unit"
            value={text(layout.unit)}
            onChange={(event) => configLayout('unit', event.target.value)}
          />
          <Input
            label="Precision"
            type="number"
            min={0}
            max={20}
            value={typeof layout.precision === 'number' ? layout.precision : ''}
            onChange={(event) => {
              const value = event.target.value;
              if (!value) {
                const next = { ...layout };
                delete next.precision;
                change({ config: { ...config, layout: next } });
              } else {
                const number = Number(value);
                if (Number.isFinite(number))
                  configLayout('precision', Math.max(0, Math.min(20, Math.floor(number))));
              }
            }}
          />
          <Select
            label="Legend position"
            value={text(layout.legendPosition, 'bottom')}
            onChange={(event) => configLayout('legendPosition', event.target.value)}
          >
            {['top', 'bottom', 'left', 'right'].map((position) => (
              <option key={position}>{position}</option>
            ))}
          </Select>
          <Input
            label="X-axis title"
            value={text(record(axes.x).title)}
            onChange={(event) => axisTitle('x', event.target.value)}
          />
          <Input
            label="Y-axis title"
            value={text(record(axes.y).title)}
            onChange={(event) => axisTitle('y', event.target.value)}
          />
        </div>
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
