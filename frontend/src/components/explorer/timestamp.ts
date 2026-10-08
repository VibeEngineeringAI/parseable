/** Arrow timestamps without an offset represent UTC, not the browser's timezone. */
export function parseEventTimestamp(value: unknown): number {
  if (typeof value !== 'string') return NaN;
  const text = value.trim();
  return Date.parse(
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
      ? `${text.replace(' ', 'T')}Z`
      : text,
  );
}
