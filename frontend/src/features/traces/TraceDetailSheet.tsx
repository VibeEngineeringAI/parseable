import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, EmptyState, Sheet } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { useAsync } from '../../hooks/useAsync';
import { ApiError } from '../../lib/apiError';
import type { ParseableClient, TraceDetailRequest, TraceDetailResponse } from '../../lib/types';
import { CopyId } from './CopyId';
import { buildWaterfall, formatDuration } from './helpers';
import { SpanWaterfall } from './SpanWaterfall';
import { SpanDetail } from './SpanDetail';

export function TraceDetailContent({
  client,
  dataset,
  detail,
}: {
  client: ParseableClient;
  dataset: string;
  detail: TraceDetailResponse;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const waterfall = useMemo(() => buildWaterfall(detail.records), [detail.records]);
  const selected =
    waterfall.rows.find(({ span }) => span.span_span_id === selectedId)?.span ??
    waterfall.rows[0]?.span;
  const errors = waterfall.rows.filter(({ span }) => span.has_error).length;
  const services = new Set(waterfall.rows.map(({ span }) => span['service.name'])).size;
  return (
    <>
      <dl className="traces-summary">
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(waterfall.totalMs)}</dd>
        </div>
        <div>
          <dt>Spans</dt>
          <dd>{waterfall.rows.length.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Services</dt>
          <dd>{services.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Errors</dt>
          <dd>
            <Badge tone={errors ? 'danger' : 'neutral'}>{errors.toLocaleString()}</Badge>
          </dd>
        </div>
      </dl>
      <div className="traces-detail-layout">
        <SpanWaterfall
          records={detail.records}
          selectedId={selected?.span_span_id}
          onSelect={(span) => setSelectedId(span.span_span_id)}
        />
        {selected && (
          <SpanDetail
            key={selected.span_span_id}
            client={client}
            dataset={dataset}
            span={selected}
            detail={detail}
          />
        )}
      </div>
    </>
  );
}

export function TraceDetailSheet({
  client,
  request,
  onClose,
  logsHref,
  agentsHref,
}: {
  client: ParseableClient;
  request: TraceDetailRequest;
  onClose: () => void;
  logsHref?: string;
  agentsHref?: string;
}) {
  const detail = useAsync(
    useCallback((signal) => client.traceDetail(request, signal), [client, request]),
  );
  const notFound = detail.error instanceof ApiError && detail.error.status === 404;
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Trace detail"
      description={`Inspect spans in ${request.dataset}.`}
      className="traces-detail-sheet"
    >
      <div className="stack">
        <CopyId label="Copy trace ID" value={request.traceId} />
        {(logsHref || agentsHref) && (
          <div className="inline">
            {logsHref && (
              <Link className="text-link" to={logsHref}>
                Open trace logs
              </Link>
            )}
            {agentsHref && (
              <Link className="text-link" to={agentsHref}>
                Open agents
              </Link>
            )}
          </div>
        )}
        <p className="muted traces-window-notice">
          Trace lookup searches the selected time window. Spans outside the discovered trace bounds
          may be unavailable.
        </p>
        <QueryState
          loading={detail.loading}
          error={notFound ? undefined : detail.error}
          retry={detail.reload}
        />
        {notFound && (
          <EmptyState
            title="Trace not found"
            description="This trace or dataset could not be found in the selected time window. Close this panel and try a wider time range."
          />
        )}
        {detail.data && !detail.data.records.length && (
          <EmptyState
            title="No spans returned"
            description="The trace bounds were found, but its span records are unavailable."
          />
        )}
        {!!detail.data?.records.length && (
          <TraceDetailContent
            key={request.traceId}
            client={client}
            dataset={request.dataset}
            detail={detail.data}
          />
        )}
      </div>
    </Sheet>
  );
}
