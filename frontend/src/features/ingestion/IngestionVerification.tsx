import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, Button, InlineError } from '../../components/ui';
import type { DatasetInfo, DatasetStats, ParseableClient } from '../../lib/types';
import { ingestionProgress, type IngestionSignal } from '../../lib/ingestion';
import { datasetError } from '../datasets/helpers';

export function IngestionVerification({
  client,
  dataset,
  signal,
  enabled,
  demo,
}: {
  client: ParseableClient;
  dataset: string;
  signal: IngestionSignal;
  enabled: boolean;
  demo: boolean;
}) {
  const request = useRef<AbortController | undefined>(undefined);
  const running = useRef(false);
  const baseline = useRef<number | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<{
    stats: DatasetStats;
    fields: string[];
    info: DatasetInfo;
    newEvents?: number;
  }>();
  useEffect(() => () => request.current?.abort(), []);
  async function check() {
    if (!enabled || demo || running.current) return;
    running.current = true;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(undefined);
    setResult(undefined);
    try {
      const [stats, fields, info] = await Promise.all([
        client.datasetStats(dataset, controller.signal),
        client.schema(dataset, controller.signal),
        client.datasetInfo(dataset, controller.signal),
      ]);
      if (!controller.signal.aborted) {
        const progress = ingestionProgress(stats, baseline.current);
        baseline.current = progress.lifetime;
        setResult({ stats, fields, info, newEvents: progress.newEvents });
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(datasetError(failure, 'read dataset ingestion status'));
    } finally {
      running.current = false;
      if (!controller.signal.aborted) setPending(false);
    }
  }
  return (
    <div className="stack ingestion-verification">
      <p>After running your setup, check the destination for ingested data.</p>
      <div className="inline">
        <Button onClick={() => void check()} disabled={!enabled || demo || pending}>
          <RefreshCw size={15} aria-hidden="true" />
          {pending ? 'Checking ingestion…' : 'Check ingestion'}
        </Button>
        <span className="muted">
          {demo
            ? 'Live verification is unavailable in demo mode.'
            : 'Reads dataset statistics and schema.'}
        </span>
      </div>
      <InlineError error={error} />
      {result && (
        <div className="ingestion-check-result" role="status">
          <Badge
            tone={result.newEvents !== undefined && result.newEvents > 0 ? 'success' : 'neutral'}
          >
            {result.newEvents === undefined
              ? result.stats.ingestion.count > 0
                ? 'Existing data'
                : result.stats.ingestion.lifetime_count > 0
                  ? 'No current events'
                  : 'No events yet'
              : result.newEvents > 0
                ? `${result.newEvents.toLocaleString()} new ${result.newEvents === 1 ? 'event' : 'events'}`
                : 'No new events'}
          </Badge>
          <dl>
            <div>
              <dt>Lifetime events</dt>
              <dd>{result.stats.ingestion.lifetime_count.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Current events</dt>
              <dd>{result.stats.ingestion.count.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Schema fields</dt>
              <dd>{result.fields.length}</dd>
            </div>
            <div>
              <dt>Server statistics time</dt>
              <dd>{result.stats.time}</dd>
            </div>
          </dl>
          {result.info.latestEventAt && <p>Latest event: {result.info.latestEventAt}</p>}
          <p>
            {result.newEvents === undefined
              ? result.stats.ingestion.count > 0
                ? 'This dataset already contains events. This check establishes a baseline; the server response does not verify this source connection.'
                : 'The server reports no current events. This check establishes a baseline. Confirm the endpoint, API key permissions, source format, and dataset header, then check again. Statistics may take time to update.'
              : result.newEvents > 0
                ? 'Lifetime ingestion increased since the previous check. These arrivals may include other senders; the server response does not verify this source connection.'
                : 'Lifetime ingestion has not increased since the previous check. Confirm your sender configuration and check again; statistics may take time to update.'}
          </p>
          {result.stats.ingestion.count > 0 && (
            <Link className="text-link" to={`/${signal}/explore/${encodeURIComponent(dataset)}`}>
              Explore {signal}
              <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
