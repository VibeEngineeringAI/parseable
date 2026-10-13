import { useState } from 'react';
import { Bot, GitBranch, MessageSquare, Wrench } from 'lucide-react';
import { Badge, Button, Tabs } from '../../components/ui';
import { AGENT_HARNESSES, mappedHarness, recordedFields } from '../../lib/agentHarnesses';
import type { AgentRun, AgentRunStatus, AgentSpan } from '../../lib/agentRuns';

export function formatAgentDuration(value?: number) {
  if (value == null) return 'Not recorded';
  if (value < 1) return `${value.toFixed(2)} ms`;
  if (value < 1000) return `${value.toFixed(0)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

export function AgentStatus({ status }: { status: AgentRunStatus }) {
  return (
    <Badge tone={status === 'failed' ? 'danger' : status === 'success' ? 'success' : 'warning'}>
      {status === 'success' ? 'Successful' : status === 'failed' ? 'Failed' : 'Incomplete'}
    </Badge>
  );
}

export function AgentTokens({ input, output }: { input?: number; output?: number }) {
  if (input == null && output == null) return <span className="agents-note">Not recorded</span>;
  return (
    <span className="agents-tokens">
      <span>{input == null ? '—' : input.toLocaleString()} in</span>
      <span>{output == null ? '—' : output.toLocaleString()} out</span>
    </span>
  );
}

function SpanIcon({ kind }: { kind: AgentSpan['kind'] }) {
  const Icon =
    kind === 'tool'
      ? Wrench
      : kind === 'model'
        ? MessageSquare
        : kind === 'agent'
          ? Bot
          : GitBranch;
  return <Icon size={14} aria-hidden="true" />;
}

function capturedValue(value: unknown) {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === 'object') return JSON.stringify(parsed, null, 2);
    } catch {
      // Plain captured text is shown verbatim, never interpreted as markup.
    }
    return value;
  }
  return JSON.stringify(value, null, 2);
}

export function AgentRunDetails({ run }: { run: AgentRun }) {
  const [tab, setTab] = useState('tree');
  const [spanId, setSpanId] = useState(run.roots[0]?.id ?? run.spans[0]?.id);
  const selected = run.spans.find((span) => span.id === spanId) ?? run.spans[0];
  const selectedHarness = selected?.rows.map(mappedHarness).find(Boolean);
  // Harness mapping can attach a span to its run when intermediate spans were not loaded.
  const recordedParent = selected?.rows
    .map((row) => recordedFields(row).span_parent_span_id ?? recordedFields(row).parent_span_id)
    .find((value) => typeof value === 'string' && value.trim() && !/^0+$/.test(value.trim()));
  const models = run.spans.filter((span) => span.kind === 'model');
  const tools = run.spans.filter((span) => span.kind === 'tool');
  const errors = run.spans.filter((span) => span.errors.length || span.status === 'failed');
  const conversation = run.spans
    .filter((span) => span.conversation.length)
    .sort((a, b) => (Date.parse(a.startTime ?? '') || 0) - (Date.parse(b.startTime ?? '') || 0));
  const spanButton = (span: AgentSpan) => (
    <button
      type="button"
      className="agents-span-button"
      aria-pressed={selected?.id === span.id}
      onClick={() => setSpanId(span.id)}
    >
      <span className="agents-span-name">
        <SpanIcon kind={span.kind} />
        {span.name}
      </span>
      <span className="agents-span-meta">
        <AgentStatus status={span.status} />
        <span>{formatAgentDuration(span.durationMs)}</span>
      </span>
    </button>
  );
  const tree = (spans: AgentSpan[], depth = 0) => (
    <ul className="agents-span-tree" aria-label={depth === 0 ? 'Run span tree' : 'Child spans'}>
      {spans.map((span) => (
        <li key={span.id}>
          {spanButton(span)}
          {!!span.children.length && tree(span.children, depth + 1)}
        </li>
      ))}
    </ul>
  );
  const calls = (spans: AgentSpan[], label: string) =>
    spans.length ? (
      <ul className="agents-call-list" aria-label={label}>
        {spans.map((span) => (
          <li key={span.id}>
            {spanButton(span)}
            <div className="agents-call-facts">
              <span>{span.model ?? span.toolName ?? 'Name not recorded'}</span>
              <AgentTokens input={span.inputTokens} output={span.outputTokens} />
            </div>
          </li>
        ))}
      </ul>
    ) : (
      <p className="agents-note">No {label.toLowerCase()} captured in the loaded spans.</p>
    );
  return (
    <div className="agents-run-details">
      <div className="agents-detail-heading">
        <h2>{run.name}</h2>
        <AgentStatus status={run.status} />
      </div>
      {run.traceId && (
        <p className="agents-run-id">
          Trace <code>{run.traceId}</code>
        </p>
      )}
      <dl className="agents-facts">
        <div>
          <dt>Started (UTC)</dt>
          <dd>{run.startTime ?? 'Not recorded'}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatAgentDuration(run.durationMs)}</dd>
        </div>
        <div>
          <dt>Models</dt>
          <dd>{run.models.join(', ') || 'Not recorded'}</dd>
        </div>
        <div>
          <dt>Token usage</dt>
          <dd>
            <AgentTokens input={run.inputTokens} output={run.outputTokens} />
          </dd>
        </div>
        <div>
          <dt>Loaded spans</dt>
          <dd>{run.spans.length.toLocaleString()}</dd>
        </div>
      </dl>
      {!!run.warnings.length && (
        <div role="status" className="agents-warnings">
          <strong>Telemetry coverage</strong>
          <ul>
            {run.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      <Tabs
        aria-label="Run details"
        value={tab}
        onValueChange={setTab}
        items={[
          { value: 'tree', label: `Span tree (${run.spans.length})`, content: tree(run.roots) },
          {
            value: 'models',
            label: `Model calls (${models.length})`,
            content: calls(models, 'Model calls'),
          },
          {
            value: 'tools',
            label: `Tool calls (${tools.length})`,
            content: calls(tools, 'Tool calls'),
          },
          {
            value: 'errors',
            label: `Errors (${errors.length})`,
            content: errors.length ? (
              <ul className="agents-error-list">
                {errors.map((span) => (
                  <li key={span.id}>
                    <Button variant="ghost" onClick={() => setSpanId(span.id)}>
                      {span.name}
                    </Button>
                    {(span.errors.length
                      ? span.errors
                      : ['Error status recorded; no error message captured.']
                    ).map((error, index) => (
                      <pre key={index} className="agents-record">
                        {error}
                      </pre>
                    ))}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="agents-note">No errors reported in the loaded spans.</p>
            ),
          },
          {
            value: 'conversation',
            label: 'Conversation',
            content: conversation.length ? (
              <div className="agents-conversation">
                {conversation.map((span) => (
                  <section key={span.id} aria-label={`Conversation from ${span.name}`}>
                    <h3>{span.name}</h3>
                    {span.conversation.map((entry, index) => (
                      <div className="agents-message" key={index}>
                        <h4>{entry.label}</h4>
                        <pre className="agents-record">{capturedValue(entry.value)}</pre>
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            ) : (
              <p className="agents-note">
                No conversation content captured in these spans. Content is shown only when your
                instrumentation records it; some exporters store messages in a separate logs
                dataset.
              </p>
            ),
          },
        ]}
      />
      {selected && (
        <section className="agents-selected-span" aria-label="Selected span">
          <div className="agents-detail-heading">
            <h3>{selected.name}</h3>
            <AgentStatus status={selected.status} />
          </div>
          <dl className="agents-facts">
            <div>
              <dt>Span ID</dt>
              <dd>
                <code>{selected.spanId ?? 'Not recorded'}</code>
              </dd>
            </div>
            <div>
              <dt>Parent span ID</dt>
              <dd>
                <code>
                  {String(
                    (selectedHarness ? recordedParent : selected.parentSpanId) ?? 'Not recorded',
                  )}
                </code>
              </dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>{selected.kind}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{formatAgentDuration(selected.durationMs)}</dd>
            </div>
            <div>
              <dt>Model / tool</dt>
              <dd>{selected.model ?? selected.toolName ?? 'Not recorded'}</dd>
            </div>
            <div>
              <dt>Token usage</dt>
              <dd>
                <AgentTokens input={selected.inputTokens} output={selected.outputTokens} />
              </dd>
            </div>
          </dl>
          {selectedHarness && (
            <p className="agents-note">
              Mapped from native {AGENT_HARNESSES[selectedHarness].label} telemetry. Recorded fields
              are shown unchanged.
            </p>
          )}
          <details className="agents-raw-fields">
            <summary>
              Recorded fields ({selected.rows.length}{' '}
              {selected.rows.length === 1 ? 'record' : 'records'})
            </summary>
            {selected.rows.map((row, index) => (
              <pre key={index} className="agents-record">
                {JSON.stringify(recordedFields(row), null, 2)}
              </pre>
            ))}
          </details>
        </section>
      )}
    </div>
  );
}
