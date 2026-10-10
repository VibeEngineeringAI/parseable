// The one display format for numeric values: charts, tables and thresholds all use it, so the same
// number never reads as 0.8500 in one place and 0.85 in another. Trailing zeros are dropped.
// Only the mantissa is trimmed: the zeros in an exponent such as e+10 are significant.
const trimmed = (text: string) => {
  const [mantissa, exponent] = text.split('e');
  const short = mantissa.includes('.') ? mantissa.replace(/\.?0+$/, '') : mantissa;
  return exponent ? `${short}e${exponent}` : short;
};

export function formatChartValue(value: number): string {
  if (!Number.isFinite(value)) return '-';
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e9) return trimmed(value.toExponential(2));
  if (magnitude >= 1e3) return value.toFixed(0);
  if (magnitude >= 1) return trimmed(value.toFixed(2));
  if (magnitude >= 0.001) return trimmed(value.toFixed(4));
  return trimmed(value.toExponential(2));
}
