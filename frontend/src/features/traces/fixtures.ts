import type { TraceDetailRecord, TraceDetailResponse, TraceListRecord } from '../../lib/types';

export const STORY_TRACE_ID = '0123456789abcdef0123456789abcdef';
export const STORY_BOUNDS = { startTime: '2026-10-12T10:00:00Z', endTime: '2026-10-12T11:00:00Z' };
export const STORY_SPAN_IDS = {
  root: '0000000000000001',
  checkout: '0000000000000002',
  database: '0000000000000003',
  inventory: '0000000000000004',
  orphan: '0000000000000005',
};

function span(
  id: string,
  parent: string,
  service: string,
  operation: string,
  start: string,
  ns: number,
  error = false,
): TraceDetailRecord {
  return {
    'service.name': service,
    span_name: operation,
    span_trace_id: STORY_TRACE_ID,
    span_span_id: id,
    span_parent_span_id: parent,
    span_start_time_unix_nano: start,
    // Deliberately lossy; consumers must rely on the timestamp string.
    span_start_time_unix_nano_epoch: 1_791_799_200_000_000_000,
    span_duration_ns: ns,
    total_span_count: 5,
    has_error: error,
    level: parent ? 1 : 0,
    event_count: error ? 1 : 0,
  };
}

export const storyTraceDetail: TraceDetailResponse = {
  // Equal ingestion bounds are valid: the span timings have their own range.
  startTime: '2026-10-12T10:20:00',
  endTime: '2026-10-12T10:20:00',
  records: [
    span(
      STORY_SPAN_IDS.root,
      '',
      'api-gateway',
      'POST /orders',
      '2026-10-12T10:20:00.000000000',
      240_000_000,
    ),
    span(
      STORY_SPAN_IDS.checkout,
      STORY_SPAN_IDS.root,
      'checkout',
      'create-order',
      '2026-10-12T10:20:00.012345678',
      150_000_000,
      true,
    ),
    span(
      STORY_SPAN_IDS.database,
      STORY_SPAN_IDS.checkout,
      'orders-db',
      'INSERT orders',
      '2026-10-12T10:20:00.021345679',
      80_000_000,
    ),
    span(
      STORY_SPAN_IDS.inventory,
      STORY_SPAN_IDS.root,
      'inventory',
      'reserve-stock',
      '2026-10-12T10:20:00.080000000',
      90_000_000,
    ),
    span(
      STORY_SPAN_IDS.orphan,
      'ffffffffffffffff',
      'payment-provider',
      'authorize-payment',
      '2026-10-12T10:20:00.170000000',
      45_000_000,
    ),
  ],
};

export const storyTraceList: TraceListRecord[] = Array.from({ length: 31 }, (_, index) => ({
  'service.name': 'api-gateway',
  span_name: index % 3 ? 'GET /products' : 'POST /orders',
  span_trace_id: index === 0 ? STORY_TRACE_ID : (index + 1).toString(16).padStart(32, '0'),
  span_span_id: (index + 1).toString(16).padStart(16, '0'),
  span_start_time_unix_nano: new Date(Date.UTC(2026, 9, 12, 10, 20) - index * 15_000).toISOString(),
  span_start_time_unix_nano_epoch: 1_791_799_200_000_000_000 - index * 15_000_000_000,
  span_duration_ns: (240 + index * 12) * 1_000_000,
  p_timestamp: new Date(Date.UTC(2026, 9, 12, 10, 20) - index * 15_000).toISOString(),
  total_span_count: 5 + (index % 4),
  error_count: index % 4 === 0 ? 1 : 0,
}));
