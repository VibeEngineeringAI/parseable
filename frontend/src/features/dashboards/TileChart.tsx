import { useCallback, useMemo } from 'react';
import { PieChart } from '../../components/charts/PieChart';
import { TimeSeriesChart } from '../../components/charts/TimeSeriesChart';
import { BubbleChart } from '../../components/charts/BubbleChart';
import { GaugeChart } from '../../components/charts/GaugeChart';
import { DataTable } from '../../components/explorer/DataTable';
import { chartResults, promqlTableRows } from '../../lib/promqlResults';
import {
  cartesianChart,
  cartesianStyle,
  promqlCategoryChart,
  type CartesianChart,
} from './cartesian';
import { gaugeModel, gaugeValue } from './gauge';
import { fillStyle, percentFill } from './chartValue';
import { QueryValue } from './QueryValue';
import { queryValueNumber, queryValueTheme, sparklineValues } from './queryValue';
import { formatValue as formatTileValue, valueFormat } from './formatValue';
import { useChartHeight } from './useChartHeight';
import { toChartSeries } from '../../lib/promql';
import type { DashboardTile } from '../../lib/types';
import { record, text, tileTitle } from './tiles';
import type { TileResults } from './queries';
import { bubbleChart } from './bubble';
import { tilePalette } from './palettes';
import { tileSlices } from './slices';
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
  const bubble = useMemo(
    () =>
      tile.chartType === 'bubble' && !result.promql && tile.tileType !== 'promql'
        ? bubbleChart(result.rows ?? [], tile)
        : undefined,
    [result, tile],
  );
  const slices = useMemo(
    () => (['pie', 'donut'].includes(text(tile.chartType)) ? tileSlices(result, tile) : []),
    [result, tile],
  );
  const unit = text(layout.unit),
    precision = typeof layout.precision === 'number' ? layout.precision : undefined,
    humanize = layout.humanize === true;
  const format = useMemo(
    () => valueFormat({ unit, precision, humanize }),
    [unit, precision, humanize],
  );
  const formatValue = useCallback((value: number) => formatTileValue(value, format), [format]);
  const xRange = useMemo(() => [start, end] as const, [start, end]);
  const fitted = useChartHeight(
    height,
    JSON.stringify([
      tile.config,
      chart.categorical,
      chart.series.map((series) => series.id),
      bubble?.groups.map((group) => group.id),
      bubble?.truncated,
    ]),
  );
  const chartType = text(tile.chartType);
  if (chartType === 'pie' || chartType === 'donut') {
    const legendPosition = text(layout.legendPosition);
    return (
      <PieChart
        slices={slices}
        variant={chartType}
        palette={tilePalette(tile)}
        showLabels={layout.label === true}
        legendPosition={
          legendPosition === 'top' || legendPosition === 'left' || legendPosition === 'right'
            ? legendPosition
            : 'bottom'
        }
        formatValue={formatValue}
        title={`${tileTitle(tile)} chart`}
        height={height === 'fit' ? undefined : height}
      />
    );
  }
  if (tile.chartType === 'bubble') {
    if (result.promql || tile.tileType === 'promql')
      return (
        <p className="muted dashboard-chart-note" role="status">
          Bubble charts are not available for PromQL tiles.
        </p>
      );
    const legend = text(layout.legendPosition);
    const legendPosition =
      legend === 'top' || legend === 'left' || legend === 'right' ? legend : 'bottom';
    const { xField, yField, sizeField, groupField, ...data } = bubble!;
    return (
      <div ref={fitted.root} className="dashboard-chart" data-legend-position={legendPosition}>
        <BubbleChart
          {...data}
          xTitle={text(record(axes.x).title) || xField}
          yTitle={text(record(axes.y).title) || yField}
          xLabel={xField}
          yLabel={yField}
          sizeLabel={sizeField}
          groupLabel={groupField}
          legendPosition={legendPosition}
          formatValue={formatValue}
          title={`${tileTitle(tile)} chart`}
          height={fitted.pixels}
          emptyMessage="No results for the selected time range"
        />
      </div>
    );
  }
  if (tile.chartType === 'gauge') {
    const value = gaugeValue(tile, result, rows);
    return value === undefined ? (
      <div
        className="charts-empty charts-gauge-empty"
        role="group"
        aria-label={`${tileTitle(tile)} value`}
      >
        No values returned
      </div>
    ) : (
      <GaugeChart
        label={tileTitle(tile)}
        model={gaugeModel(value, tile)}
        text={formatValue(value)}
      />
    );
  }
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
    const value = queryValueNumber(tile, result, rows);
    const fill = value === undefined ? undefined : percentFill(value, tile);
    return (
      <QueryValue
        label={tileTitle(tile)}
        text={value === undefined ? undefined : formatValue(value)}
        theme={queryValueTheme(tile)}
        fill={fill === undefined ? undefined : { style: fillStyle(tile), percent: fill }}
        spark={sparklineValues(tile, result, chart)}
      />
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
