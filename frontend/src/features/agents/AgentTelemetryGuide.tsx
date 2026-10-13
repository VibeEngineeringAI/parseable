import { useState } from 'react';
import { Link } from 'react-router-dom';
import '../ingestion/ingestion.css';
import { Input, Tabs } from '../../components/ui';
import { CommandCodeBlock } from '../ingestion/CommandCodeBlock';
import {
  DEFAULT_COLLECTOR_ENDPOINT,
  generateTelemetryAgentBrief,
  generateTelemetryConfig,
  validateCollectorEndpoint,
  type TelemetryProvider,
} from './agentTelemetrySetup';

export function AgentTelemetryGuide() {
  const [provider, setProvider] = useState<TelemetryProvider>('claude');
  const [endpoint, setEndpoint] = useState(DEFAULT_COLLECTOR_ENDPOINT);
  const [capture, setCapture] = useState(false);
  const validated = validateCollectorEndpoint(endpoint);
  function providerContent(selected: TelemetryProvider) {
    const claude = selected === 'claude';
    return (
      <div className="agent-setup-provider">
        <h3>1. Choose your collector</h3>
        <p>
          The collector must already be running. Use its OTLP HTTP base URL, with an optional path
          prefix. This is not a bare Parseable ingestion URL: the collector’s exporter needs
          Parseable authentication and a trace dataset with <code>X-P-Stream</code>. Keep OTLP logs
          in a separate dataset, using separate collector pipelines and exporters with distinct
          X-P-Stream values.{' '}
          <Link className="text-link" to="/add-data">
            View collector and ingestion setup
          </Link>
          .
        </p>
        <Input
          label="Collector base URL"
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
          error={validated.error}
          hint="The local default is http://127.0.0.1:4318. Localhost refers to the environment running your agent."
        />
        <label className="agent-setup-capture">
          <input
            type="checkbox"
            checked={capture}
            onChange={(event) => setCapture(event.target.checked)}
          />{' '}
          {claude ? 'Include prompts and supported response/tool content' : 'Include user prompts'}
        </label>
        <p className="agent-setup-hint">
          {claude
            ? 'Content flags are off by default. Enabling them can export sensitive prompts, responses and tool content when supported; identity metadata and file paths may still be exported with these flags off. Logs are not automatically attached to spans.'
            : 'Prompt logging is off by default. Enabling it exports user prompts; this is not a full transcript switch and tool output snippets and identity metadata may still be exported when this is off.'}
        </p>

        <h3>2. Merge into user settings</h3>
        <p>
          Preserve existing settings in{' '}
          <code>{claude ? '~/.claude/settings.json' : '~/.codex/config.toml'}</code>.{' '}
          {claude
            ? 'Merge the env object; reconcile existing destinations and authentication before replacing these keys. Exporter settings are honored in user or managed configuration, not project settings. Managed destinations may override yours. Enhanced telemetry is a beta feature.'
            : 'Edit existing otel keys and inline exporters in place. Duplicate otel tables or exporter keys make TOML invalid. Project otel settings are ignored. CODEX_HOME can relocate the user config file.'}
        </p>
        {validated.endpoint && (
          <CommandCodeBlock
            code={generateTelemetryConfig(selected, validated.endpoint, capture)}
            title={claude ? 'Claude Code settings' : 'Codex settings'}
            language={claude ? 'JSON' : 'TOML'}
          />
        )}
        <p>
          Restart the actual CLI or agent runtime to apply settings. Enabling an exporter alone does
          not guarantee complete runs in Agents.
        </p>
        <h3>3. Validate real telemetry</h3>
        <p>
          Confirm collector receipt and stored rows first, then run discovery, parent links, models,
          tools and usage in Agents. Test successful, failed and interrupted work. Agents reads
          native Claude Code and Codex trace fields directly, so their trace datasets need no field
          mapping. Runs come from traces; a logs dataset is not listed on its own.
        </p>
        <details className="agent-setup-details">
          <summary>Mapping and validation checklist</summary>
          <p>For other agents and frameworks:</p>
          <ul>
            <li>
              Map agent and operation to <code>gen_ai.agent.name</code> and{' '}
              <code>gen_ai.operation.name</code>; models to <code>gen_ai.request.model</code> /{' '}
              <code>gen_ai.response.model</code>; tools to <code>gen_ai.tool.name</code>.
            </li>
            <li>
              Map usage to <code>gen_ai.usage.input_tokens</code> and{' '}
              <code>gen_ai.usage.output_tokens</code>, including cached input tokens in the input
              total. Preserve absent values as unknown.
            </li>
            <li>
              Validate 32-digit hexadecimal trace IDs, 16-digit hexadecimal span IDs, parent IDs,
              timestamps and status. Retain errors and unfinished spans; do not group an entire
              session as one run.
            </li>
            <li>
              Put GenAI attributes on spans, not just resource metadata. Optional structured
              messages use <code>gen_ai.input.messages</code> / <code>gen_ai.output.messages</code>.
              Prompt capture is not a full transcript guarantee.
            </li>
            <li>
              An ordinary collector does not reconstruct GenAI runs automatically. Provider mapping
              or a stateful adapter may be needed. Missing telemetry stays unknown or incomplete; do
              not invent content, usage, costs or evaluations.
            </li>
          </ul>
        </details>
        <details className="agent-setup-details">
          <summary>Copy instructions for your coding agent</summary>
          {validated.endpoint && (
            <CommandCodeBlock
              code={generateTelemetryAgentBrief(selected, validated.endpoint, capture)}
              title="Telemetry setup agent brief"
              language="Text"
            />
          )}
        </details>
        <p className="agent-setup-sources">
          Official documentation:{' '}
          {claude ? (
            <a
              href="https://code.claude.com/docs/en/monitoring-usage"
              target="_blank"
              rel="noreferrer"
            >
              Claude Code telemetry
            </a>
          ) : (
            <>
              <a
                href="https://learn.chatgpt.com/docs/config-file/config-reference"
                target="_blank"
                rel="noreferrer"
              >
                Codex configuration
              </a>{' '}
              ·{' '}
              <a
                href="https://learn.chatgpt.com/docs/config-file/config-advanced#observability-and-telemetry"
                target="_blank"
                rel="noreferrer"
              >
                Codex telemetry
              </a>
            </>
          )}
        </p>
      </div>
    );
  }
  return (
    <div className="agent-setup-guide">
      <p>
        Connect Claude Code or Codex through an OpenTelemetry collector, then map real telemetry
        into the Agents span format.
      </p>
      <Tabs
        value={provider}
        onValueChange={(value) => {
          setProvider(value as TelemetryProvider);
          setCapture(false);
        }}
        aria-label="Coding agent"
        items={[
          { value: 'claude', label: 'Claude Code', content: providerContent('claude') },
          { value: 'codex', label: 'Codex', content: providerContent('codex') },
        ]}
      />
    </div>
  );
}
