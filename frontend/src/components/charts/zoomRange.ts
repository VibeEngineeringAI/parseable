export type ZoomRange = { startTime: string; endTime: string };

export function zoomRange(timestamps: number[], from: number, to: number): ZoomRange | undefined {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
  const start = Math.min(from, to),
    end = Math.max(from, to);
  if (timestamps.filter((timestamp) => timestamp >= start && timestamp <= end).length < 2)
    return undefined;
  return {
    startTime: new Date(Math.floor(start) * 1000).toISOString(),
    endTime: new Date(Math.ceil(end) * 1000).toISOString(),
  };
}
