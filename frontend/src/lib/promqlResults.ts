import { parseSampleValue, seriesLabel, toChartSeries } from './promql';
import type { PromqlInstantResult, PromqlRangeResult } from './types';
export type QueryResult = {
  id: string;
  pending: number;
  range?: PromqlRangeResult;
  instant?: PromqlInstantResult;
  errors: Array<{ kind: 'range' | 'instant'; error: Error }>;
};

export function chartResults(results: QueryResult[], queryCount: number) {
  const charts = results.flatMap((row) => (row.range ? [toChartSeries(row.range, row.id)] : []));
  const timestamps = [...new Set(charts.flatMap((chart) => chart.timestamps))].sort(
    (a, b) => a - b,
  );
  const series = charts.flatMap((chart) =>
    chart.series.map((series) => {
      const values = new Map(chart.timestamps.map((time, index) => [time, series.values[index]]));
      return {
        ...series,
        label: queryCount > 1 ? series.label : series.label.slice(series.id.indexOf(':') + 2),
        values: timestamps.map((time) => values.get(time) ?? null),
      };
    }),
  );
  return { timestamps, series };
}

const finiteValue = (value: string) => {
  const parsed = parseSampleValue(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function instantRows(results: QueryResult[], queryCount: number) {
  return results.flatMap(({ id, instant }) => {
    if (!instant) return [];
    const prefix = queryCount > 1 ? `${id}: ` : '';
    if (instant.resultType === 'scalar' || instant.resultType === 'string')
      return [{ Series: `${prefix}scalar`, Value: finiteValue(instant.result[1]) }];
    if (instant.resultType === 'vector')
      return instant.result.map(({ metric, value }) => ({
        Series: `${prefix}${seriesLabel(metric, { keepName: true })}`,
        Value: finiteValue(value[1]),
      }));
    if (instant.resultType !== 'matrix') return [];
    return instant.result.map(({ metric, values }) => ({
      Series: `${prefix}${seriesLabel(metric, { keepName: true })}`,
      Value: values.length
        ? finiteValue(values.reduce((last, sample) => (sample[0] >= last[0] ? sample : last))[1])
        : null,
      Samples: values.length,
    }));
  });
}
