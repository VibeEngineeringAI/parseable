export function formatChartValue(value: number): string {
  if (!Number.isFinite(value)) return '-';
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e9) return value.toExponential(2);
  if (magnitude >= 1e3) return value.toFixed(0);
  if (magnitude >= 1) return value.toFixed(2);
  if (magnitude >= 0.001) return value.toFixed(4);
  return value.toExponential(2);
}
