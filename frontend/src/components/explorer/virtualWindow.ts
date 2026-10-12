/** A bounded, overscanned interval; shared by row and column virtualization. */
export function virtualWindow(
  count: number,
  offset: number,
  viewport: number,
  size: number,
  overscan = 3,
) {
  const start = Math.max(0, Math.min(count, Math.floor(Math.max(0, offset) / size) - overscan));
  const end = Math.min(
    count,
    Math.max(start, Math.ceil((Math.max(0, offset) + viewport) / size) + overscan),
  );
  return { start, end };
}
