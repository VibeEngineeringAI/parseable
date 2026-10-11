import { useCallback, useMemo } from 'react';
import { TimeSeriesChart } from '../../components/charts/TimeSeriesChart';
import { DataTable } from '../../components/explorer/DataTable';
import { chartResults, promqlTableRows } from '../../lib/promqlResults';
import {
  cartesianChart,
  cartesianStyle,
  promqlCategoryChart,
  type CartesianChart,
} from './cartesian';
import { chartValue, diagonalFill, fillStyle, percentFill } from './chartValue';
import { tilePalette } from './palettes';
import { useChartHeight } from './useChartHeight';
import { toChartSeries } from '../../lib/promql';
import type { DashboardTile } from '../../lib/types';
import { record, text, tileTitle } from './tiles';
import type { TileResults } from './queries';
export function TileChart({
  tile,
  result,
  start,
  end,
  height,
}: {
  tile: DashboardTile;
  result: TileResults;
  start: number;
  end: number;
  height: number | 'fit';
}) {
  const config = record(tile.config),
    layout = record(config.layout),
    axes = record(config.axes);
  const chart = useMemo<CartesianChart>(() => {
    if (!result.promql) return cartesianChart(result.rows ?? [], tile);
    if (['timeseries', 'line', 'area', 'bar'].includes(text(tile.chartType))) {
      const categorical = promqlCategoryChart(result.promql);
      if (categorical) return categorical;
    }
    const converted = result.promql.map((row) =>
      row.range
        ? row
        : {
            ...row,
            range:
              row.instant?.resultType === 'vector'
                ? {
                    resultType: 'matrix' as const,
                    result: row.instant.result.map((item) => ({
                      metric: item.metric,
                      values: [item.value],
                    })),
                  }
                : row.instant?.resultType === 'scalar'
                  ? {
                      resultType: 'matrix' as const,
                      result: [{ metric: {}, values: [row.instant.result] }],
                    }
                  : row.instant?.resultType === 'matrix'
                    ? row.instant
                    : undefined,
          },
    );
    if (converted.length === 1 && converted[0].range)
      return { ...toChartSeries(converted[0].range), categorical: false };
    return { ...chartResults(converted, converted.length), categorical: false };
  }, [result, tile]);
  const rows = useMemo(
    () => result.rows ?? (result.promql ? promqlTableRows(result.promql) : []),
    [result],
  );
  const precision =
    typeof layout.precision === 'number' && Number.isFinite(layout.precision)
      ? Math.max(0, Math.min(20, Math.floor(layout.precision)))
      : undefined;
  const unit = text(layout.unit);
  const formatValue = useCallback(
    (value: number) =>
      `${precision === undefined ? value.toLocaleString() : value.toFixed(precision)}${unit ? ` ${unit}` : ''}`,
    [precision, unit],
  );
  const xRange = useMemo(() => [start, end] as const, [start, end]);
  const fitted = useChartHeight(
    height,
    JSON.stringify([tile.config, chart.categorical, chart.series.map((series) => series.id)]),
  );
  if (tile.chartType === 'table' || (chart.categorical && tile.chartType !== 'query-value'))
    return (
      <div
        className="dashboard-table"
        role="region"
        aria-label={`${tileTitle(tile)} results`}
        tabIndex={0}
      >
        {chart.categorical && tile.chartType !== 'table' && (
          <p className="muted dashboard-chart-note">
            The x values are not timestamps, so the results are shown as a table.
          </p>
        )}
        <DataTable rows={rows} caption={`${tileTitle(tile)} results`} />
      </div>
    );
  if (tile.chartType === 'query-value') {
    const value = chartValue(rows, tile, !!result.promql);
    const fill = value === undefined ? undefined : percentFill(value, tile);
    const style = fillStyle(tile);
    return (
      <div className="dashboard-stat" role="group" aria-label={`${tileTitle(tile)} value`}>
        {fill !== undefined && (
          <span
            className="dashboard-stat-fill"
            data-direction={style}
            style={
              style === 'vertical'
                ? { height: `${fill}%` }
                : style === 'diagonal'
                  ? { clipPath: diagonalFill(fill) }
                  : { width: `${fill}%` }
            }
            aria-hidden="true"
          />
        )}
        {value === undefined ? 'No values returned' : formatValue(value)}
      </div>
    );
  }
  const style = cartesianStyle(tile),
    horizontal = style.horizontal && chart.categories !== undefined;
  return (
    <div
      ref={fitted.root}
      className="dashboard-chart"
      data-legend-position={text(layout.legendPosition, 'bottom')}
      data-chart-kind={style.kind === 'bar' ? 'bar' : style.fill ? 'area' : 'line'}
      data-stacked={style.stacked}
      data-orientation={horizontal ? 'horizontal' : 'vertical'}
    >
      {text(record(axes.y).title) && (
        <p className="muted dashboard-axis-title">{text(record(axes.y).title)}</p>
      )}
      <TimeSeriesChart
        timestamps={chart.timestamps}
        series={chart.series}
        categories={chart.categories}
        kind={style.kind}
        fill={style.fill}
        smooth={style.smooth}
        stacked={style.stacked}
        horizontal={style.horizontal}
        colors={tilePalette(tile)}
        showXAxis={record(axes.x).display !== false}
        paddedBounds
        title={`${tileTitle(tile)} chart`}
        showTitle={false}
        xAxisTitle={text(record(axes.x).title)}
        showSeriesCount={false}
        height={fitted.pixels}
        yAxisSize={
          horizontal
            ? Math.max(
                64,
                Math.min(
                  180,
                  Math.max(0, ...(chart.categories ?? []).map((label) => label.length)) * 7 + 24,
                ),
              )
            : chart.series.reduce<number>(
                (size, series) =>
                  series.values.reduce<number>(
                    (width, value) =>
                      value !== null && Number.isFinite(value)
                        ? Math.max(width, formatValue(value).length * 7 + 24)
                        : width,
                    size,
                  ),
                64,
              )
        }
        announceSeries={false}
        xRange={chart.categories ? undefined : xRange}
        formatValue={formatValue}
        emptyMessage="No results for the selected time range"
      />
    </div>
  );
}
