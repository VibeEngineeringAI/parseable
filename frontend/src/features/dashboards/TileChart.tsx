import { useCallback, useMemo } from 'react';
import { TimeSeriesChart } from '../../components/charts/TimeSeriesChart';
import { GaugeChart } from '../../components/charts/GaugeChart';
import { DataTable } from '../../components/explorer/DataTable';
import { chartResults, promqlTableRows } from '../../lib/promqlResults';
import { gaugeModel, gaugeValue } from './gauge';
import { chartValue, diagonalFill, fillStyle, percentFill } from './chartValue';
import { formatValue as formatTileValue, valueFormat } from './formatValue';
import { useChartHeight } from './useChartHeight';
import { toChartSeries } from '../../lib/promql';
import type { DashboardTile } from '../../lib/types';
import { record, sqlChart, text, tileTitle } from './tiles';
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
  const chart = useMemo(() => {
    if (!result.promql) return sqlChart(result.rows ?? [], tile);
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
    JSON.stringify([tile.config, chart.categorical, chart.series.map((series) => series.id)]),
  );
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
  return (
    <div
      ref={fitted.root}
      className="dashboard-chart"
      data-legend-position={text(layout.legendPosition, 'bottom')}
    >
      {text(record(axes.y).title) && (
        <p className="muted dashboard-axis-title">{text(record(axes.y).title)}</p>
      )}
      <TimeSeriesChart
        timestamps={chart.timestamps}
        series={chart.series}
        title={`${tileTitle(tile)} chart`}
        showTitle={false}
        xAxisTitle={text(record(axes.x).title)}
        showSeriesCount={false}
        height={fitted.pixels}
        yAxisSize={chart.series.reduce<number>(
          (size, series) =>
            series.values.reduce<number>(
              (width, value) =>
                value !== null && Number.isFinite(value)
                  ? Math.max(width, formatValue(value).length * 7 + 24)
                  : width,
              size,
            ),
          64,
        )}
        announceSeries={false}
        xRange={xRange}
        formatValue={formatValue}
        emptyMessage="No results for the selected time range"
      />
    </div>
  );
}
