import { object } from './teamContract';
import type { DatasetHotTier, DatasetRetention, DatasetStats } from './types';

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;
const bytes = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+ Bytes$/.test(value);

export function datasetStats(value: unknown): value is DatasetStats {
  if (
    !object(value) ||
    typeof value.stream !== 'string' ||
    typeof value.time !== 'string' ||
    !Number.isFinite(Date.parse(value.time)) ||
    !object(value.ingestion) ||
    !object(value.storage)
  )
    return false;
  const { ingestion, storage } = value;
  return (
    typeof ingestion.format === 'string' &&
    typeof storage.format === 'string' &&
    [
      ingestion.count,
      ingestion.size,
      ingestion.lifetime_count,
      ingestion.lifetime_size,
      ingestion.deleted_count,
      ingestion.deleted_size,
      storage.size,
      storage.lifetime_size,
      storage.deleted_size,
    ].every(count)
  );
}

export function datasetRetention(value: unknown): value is DatasetRetention {
  return (
    Array.isArray(value) &&
    value.length <= 1 &&
    value.every((task) => {
      if (
        !object(task) ||
        typeof task.description !== 'string' ||
        task.action !== 'delete' ||
        typeof task.duration !== 'string' ||
        !/^\d+d$/.test(task.duration)
      )
        return false;
      const days = Number(task.duration.slice(0, -1));
      return days >= 1 && days <= 36500;
    })
  );
}

export function datasetHotTier(value: unknown): value is DatasetHotTier {
  return (
    object(value) &&
    (value.version === null || typeof value.version === 'string') &&
    bytes(value.size) &&
    bytes(value.used_size) &&
    bytes(value.available_size) &&
    (value.oldest_date_time_entry === undefined || typeof value.oldest_date_time_entry === 'string')
  );
}
