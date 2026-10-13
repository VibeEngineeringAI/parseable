import { describe, expect, it } from 'vitest';
import {
  generateTelemetryAgentBrief,
  generateTelemetryConfig,
  validateCollectorEndpoint,
  type TelemetryProvider,
} from './agentTelemetrySetup';

describe('collector endpoint validation', () => {
  it.each([
    '',
    'not a URL',
    'ftp://collector.example',
    'file:///tmp/collector',
    'https://user:password@collector.example',
    'https://user@collector.example',
    'https://collector.example?token=secret',
    'https://collector.example?',
    'https://collector.example#secret',
    'https://collector.example#',
  ])('rejects unsafe or invalid endpoint %s', (endpoint) => {
    const result = validateCollectorEndpoint(endpoint);
    expect(result.endpoint).toBeUndefined();
    expect(result.error).toBeTruthy();
    expect(() => generateTelemetryConfig('codex', endpoint, false)).toThrow();
  });

  it('keeps a path prefix while normalizing surrounding whitespace and trailing slashes', () => {
    expect(validateCollectorEndpoint(' https://collector.example/otel/team/// ')).toEqual({
      endpoint: 'https://collector.example/otel/team',
    });
    expect(validateCollectorEndpoint('http://127.0.0.1:4318/')).toEqual({
      endpoint: 'http://127.0.0.1:4318',
    });
  });
});

describe('telemetry configuration', () => {
  it.each([false, true])('produces valid Claude JSON with capture=%s', (capture) => {
    const { env } = JSON.parse(
      generateTelemetryConfig('claude', 'https://collector.example/team/', capture),
    );
    expect(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe('https://collector.example/team/v1/traces');
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe('https://collector.example/team/v1/logs');
    expect(env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL).toBe('http/json');
    expect(env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL).toBe('http/json');
    expect(env).not.toHaveProperty('OTEL_METRICS_EXPORTER');
    expect(env).not.toHaveProperty('OTEL_EXPORTER_OTLP_ENDPOINT');
    expect(env).not.toHaveProperty('OTEL_EXPORTER_OTLP_PROTOCOL');
    for (const key of [
      'OTEL_LOG_USER_PROMPTS',
      'OTEL_LOG_ASSISTANT_RESPONSES',
      'OTEL_LOG_TOOL_DETAILS',
      'OTEL_LOG_TOOL_CONTENT',
    ]) {
      expect(env[key]).toBe(capture ? '1' : '0');
    }
    expect(env).not.toHaveProperty('ENABLE_BETA_TRACING_DETAILED');
    expect(env).not.toHaveProperty('BETA_TRACING_ENDPOINT');
  });

  it.each([false, true])(
    'produces separate Codex signal destinations with capture=%s',
    (capture) => {
      const config = generateTelemetryConfig('codex', 'https://collector.example/team/', capture);
      expect(config).toContain(`log_user_prompt = ${capture}`);
      expect(config).toContain(
        '[otel.exporter.otlp-http]\nendpoint = "https://collector.example/team/v1/logs"\nprotocol = "json"',
      );
      expect(config).toContain(
        '[otel.trace_exporter.otlp-http]\nendpoint = "https://collector.example/team/v1/traces"\nprotocol = "json"',
      );
    },
  );

  it('encodes a literal quote in a path instead of injecting TOML syntax', () => {
    const config = generateTelemetryConfig('codex', 'https://collector.example/a"b', false);
    const endpoints = [...config.matchAll(/^endpoint = (.+)$/gm)].map((match) =>
      JSON.parse(match[1]),
    );
    expect(endpoints).toEqual([
      'https://collector.example/a%22b/v1/logs',
      'https://collector.example/a%22b/v1/traces',
    ]);
  });
});

describe('agent brief', () => {
  it.each<TelemetryProvider>(['claude', 'codex'])(
    'includes current %s configuration and capture choice',
    (provider) => {
      for (const capture of [false, true]) {
        const endpoint = 'https://collector.example/team';
        const brief = generateTelemetryAgentBrief(provider, endpoint, capture);
        expect(brief).toContain(generateTelemetryConfig(provider, endpoint, capture));
        expect(brief).toContain(
          capture
            ? 'Requested content flags are explicitly enabled'
            : 'Requested content flags are disabled; do not enable without my opt-in',
        );
      }
    },
  );
});
