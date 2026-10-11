import { strings } from '../../lib/guards';
import { parseSampleValue, seriesLabel } from '../../lib/promql';
import type { QueryResult } from '../../lib/promqlResults';
import type { DashboardTile, LogRecord } from '../../lib/types';
import { record, sqlChart, text } from './tiles';

export type CartesianStyle = {
  kind: 'line' | 'bar';
  fill: boolean;
  smooth: boolean;
  stacked: boolean;
  horizontal: boolean;
};
export type CartesianChart = {
  categorical: boolean;
  timestamps: number[];
  categories?: string[];
  series: { id: string; label: string; values: (number | null)[] }[];
};

export function cartesianStyle(tile: DashboardTile): CartesianStyle {
  const config = record(tile.config),
    layout = record(config.layout),
    yField = record(record(config.axes).y).field;
  const kind =
    tile.chartType === 'bar' ||
    (tile.chartType === 'timeseries' &&
      config.type === 'bar' &&
      !(Array.isArray(yField) && yField.length > 1))
      ? 'bar'
      : 'line';
  return {
    kind,
    fill:
      kind === 'line' &&
      (tile.chartType === 'area' ||
        (['timeseries', 'line'].includes(text(tile.chartType)) && config.type === 'area')),
    smooth: tile.chartType === 'line' || tile.chartType === 'area',
    stacked: kind === 'bar' && layout.stacked === true,
    horizontal: kind === 'bar' && layout.barOrientation === 'horizontal',
  };
}

const numericValue = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function cartesianChart(rows: LogRecord[], tile: DashboardTile): CartesianChart {
  const chart = sqlChart(rows, tile);
  if (!chart.categorical || tile.chartType === 'table') return chart;
  const axes = record(record(tile.config).axes),
    xField = text(record(axes.x).field),
    yField = record(axes.y).field;
  const yFields = strings(yField) ? yField : text(yField) ? [text(yField)] : [];
  if (!xField || !yFields.length || yFields.some((field) => !field)) return chart;
  const configuredGroups = record(axes.groupBy).field;
  const groupFields = strings(configuredGroups) ? configuredGroups : [];
  let categories: string[], series: CartesianChart['series'];
  if (!groupFields.length) {
    const points = rows.filter((row) => row[xField] != null);
    categories = points.map((row) => String(row[xField]));
    series = categories.length
      ? yFields.map((field) => ({
          id: field,
          label: field,
          values: points.map((row) => numericValue(row[field])),
        }))
      : [];
  } else {
    const categorySet = new Set<string>();
    const groups = new Map<string, { label: string; values: Map<string, number> }>();
    for (const row of rows) {
      const parts = groupFields.map((field) => String(row[field] ?? '').trim());
      if (parts.every((part) => !part)) continue;
      const group = parts.join(' | '),
        category = String(row[xField] ?? group);
      categorySet.add(category);
      for (const field of yFields) {
        const id = JSON.stringify([group, field]);
        let entry = groups.get(id);
        if (!entry) {
          entry = {
            label: yFields.length > 1 ? `${group} | ${field}` : group,
            values: new Map(),
          };
          groups.set(id, entry);
        }
        entry.values.set(
          category,
          (entry.values.get(category) ?? 0) + (numericValue(row[field]) ?? 0),
        );
      }
    }
    categories = [...categorySet].sort();
    series = [...groups].map(([id, entry]) => ({
      id,
      label: entry.label,
      values: categories.map((category) => entry.values.get(category) ?? 0),
    }));
  }
  return {
    categorical: false,
    categories,
    timestamps: categories.map((_, index) => index),
    series,
  };
}

export function promqlCategoryChart(results: QueryResult[]): CartesianChart | undefined {
  if (
    results.some((row) => row.range) ||
    !results.some(
      (row) => row.instant?.resultType === 'vector' || row.instant?.resultType === 'scalar',
    )
  )
    return undefined;
  const categories: string[] = [],
    values: number[] = [];
  for (const { id, instant } of results) {
    const prefix = results.length > 1 ? `${id}: ` : '';
    const samples =
      instant?.resultType === 'vector'
        ? instant.result.map(({ metric, value }) => ({
            label: seriesLabel(metric, { keepName: true }),
            value: value[1],
          }))
        : instant?.resultType === 'scalar'
          ? [{ label: 'scalar', value: instant.result[1] }]
          : [];
    for (const sample of samples) {
      const value = parseSampleValue(sample.value);
      if (!Number.isFinite(value)) continue;
      categories.push(`${prefix}${sample.label}`);
      values.push(value);
    }
  }
  return {
    categorical: false,
    categories,
    timestamps: categories.map((_, index) => index),
    series: [{ id: 'value', label: 'value', values }],
  };
}
