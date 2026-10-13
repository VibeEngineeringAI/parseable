export type TelemetryProvider = 'claude' | 'codex';

export const DEFAULT_COLLECTOR_ENDPOINT = 'http://127.0.0.1:4318';

export function validateCollectorEndpoint(value: string): { endpoint?: string; error?: string } {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
      return { error: 'Enter an HTTP or HTTPS collector URL.' };
    }
    if (url.username || url.password || url.search || url.hash || /[?#]/.test(value)) {
      return { error: 'Use a collector URL without credentials, query parameters, or a fragment.' };
    }
    return { endpoint: url.href.replace(/\/+$/, '') };
  } catch {
    return { error: 'Enter a valid collector URL, for example http://127.0.0.1:4318.' };
  }
}

export function generateTelemetryConfig(
  provider: TelemetryProvider,
  endpoint: string,
  capture: boolean,
): string {
  const validated = validateCollectorEndpoint(endpoint);
  if (!validated.endpoint) throw new Error(validated.error);
  const base = validated.endpoint;
  if (provider === 'claude') {
    const flag = capture ? '1' : '0';
    return JSON.stringify(
      {
        env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: '1',
          CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
          OTEL_TRACES_EXPORTER: 'otlp',
          OTEL_LOGS_EXPORTER: 'otlp',
          OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/json',
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${base}/v1/traces`,
          OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${base}/v1/logs`,
          OTEL_LOG_USER_PROMPTS: flag,
          OTEL_LOG_ASSISTANT_RESPONSES: flag,
          OTEL_LOG_TOOL_DETAILS: flag,
          OTEL_LOG_TOOL_CONTENT: flag,
        },
      },
      null,
      2,
    );
  }
  return `[otel]\nlog_user_prompt = ${capture}\n\n[otel.exporter.otlp-http]\nendpoint = ${JSON.stringify(`${base}/v1/logs`)}\nprotocol = "json"\n\n[otel.trace_exporter.otlp-http]\nendpoint = ${JSON.stringify(`${base}/v1/traces`)}\nprotocol = "json"`;
}

export function generateTelemetryAgentBrief(
  provider: TelemetryProvider,
  endpoint: string,
  capture: boolean,
): string {
  const config = generateTelemetryConfig(provider, endpoint, capture);
  return `Set up ${provider === 'claude' ? 'Claude Code' : 'Codex'} telemetry for Parseable Agents.
Inspect the installed runtime/version and its actual config location first. Merge the following settings into user config, preserving unrelated settings and respecting managed policy. Reconcile existing exporter endpoints and authentication before changing them; do not redirect other signals or disable an existing metrics pipeline. Merge existing TOML tables in place, including inline exporters, rather than appending duplicate keys/tables. Project telemetry config is not sufficient. Never print or copy secrets. Requested content flags are ${capture ? 'explicitly enabled' : 'disabled; do not enable without my opt-in'}. These flags do not suppress all sensitive data: identity metadata and file paths, or Codex tool output snippets, may still be exported. Codex log_user_prompt controls only user prompts. Restart the actual runtime after the change.

${config}

Use an already configured collector; configure its authenticated Parseable exporter separately with the destination trace dataset and X-P-Stream. Use separate collector logs and traces pipelines/exporters with distinct X-P-Stream values for their destination datasets. Keep credentials in the existing secret mechanism. Inspect real payloads from this installed runtime, map provider fields to the dashboard GenAI span contract, and preserve missing values as unknown. Claude input token totals include input_tokens + cache_read_tokens + cache_creation_tokens, only when those values are present. Map tool_name to gen_ai.tool.name. Codex trace schema must be captured and checked from this installed runtime. Prompt capture does not guarantee a full transcript.

Validate transport first (collector receipt and stored rows), then dashboard compatibility: run discovery, trace/parent relationships, models, tools, usage, and any captured messages. Test successful, failed, and interrupted/incomplete work; missing telemetry remains unknown/incomplete. Do not invent content, tokens, costs, evaluations, or live state. A synthetic fixture alone does not prove native CLI compatibility. Report changed files, restart steps, observed payload mappings, evidence, limitations, and how to restore previous exporter settings.`;
}
