import { Braces, Network, Workflow } from 'lucide-react';
import { Badge, Select } from '../../components/ui';
import type { IngestionSignal, IngestionSource } from '../../lib/ingestion';

const sources = [
  {
    id: 'json',
    name: 'JSON HTTP',
    icon: Braces,
    detail: 'Send structured events directly from a script or application.',
    badge: 'Quickstart',
  },
  {
    id: 'otlp',
    name: 'OTLP HTTP',
    icon: Network,
    detail: 'Forward a single OpenTelemetry signal over HTTP with JSON.',
    badge: 'OpenTelemetry',
  },
  {
    id: 'collector',
    name: 'OpenTelemetry Collector',
    icon: Workflow,
    detail: 'Receive telemetry from your applications and export to Parseable.',
    badge: 'Pipeline',
  },
] as const;

export function SourcePicker({
  source,
  signal,
  onSourceChange,
  onSignalChange,
  disabled = false,
}: {
  source: IngestionSource;
  signal: IngestionSignal;
  onSourceChange: (value: IngestionSource) => void;
  onSignalChange: (value: IngestionSignal) => void;
  disabled?: boolean;
}) {
  return (
    <div className="ingestion-source-picker">
      <fieldset className="ingestion-source-grid" disabled={disabled}>
        <legend className="sr-only">Choose a data source</legend>
        {sources.map(({ id, name, icon: Icon, detail, badge }) => (
          <label key={id} className="ingestion-source-card" data-selected={source === id}>
            <input
              type="radio"
              name="ingestion-source"
              value={id}
              checked={source === id}
              onChange={() => onSourceChange(id)}
            />
            <Icon size={22} aria-hidden="true" />
            <span className="ingestion-source-title">{name}</span>
            <span className="ingestion-source-description">{detail}</span>
            <Badge>{badge}</Badge>
          </label>
        ))}
      </fieldset>
      {source !== 'json' && (
        <div className="ingestion-signal-row">
          <Select
            label="Signal"
            value={signal}
            disabled={disabled}
            onChange={(event) => onSignalChange(event.target.value as IngestionSignal)}
          >
            <option value="logs">Logs</option>
            <option value="metrics">Metrics</option>
            <option value="traces">Traces</option>
          </Select>
          <p>
            Pick one signal per dataset. Repeat setup with another dataset for each additional
            signal.
          </p>
        </div>
      )}
    </div>
  );
}
