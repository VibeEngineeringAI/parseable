import { describe, expect, it } from 'vitest';
import {
  detectAgentHarness,
  mapHarnessRows,
  mappedHarness,
  recordedFields,
} from './agentHarnesses';
import { buildAgentRunQuery, isAgentSchema } from './agents';
import { buildAgentRuns } from './agentRuns';
import type { LogRecord } from './types';

// Trimmed from spans exported by Codex CLI 0.162.1 (app server) and Claude Code
// 2.1.296 with CLAUDE_CODE_ENHANCED_TELEMETRY_BETA, as stored by Parseable.
function span(
  trace: string,
  id: string,
  parent: string,
  name: string,
  start: number,
  durationMs: number,
  fields: LogRecord = {},
): LogRecord {
  const begin = Date.parse('2026-10-13T02:50:34Z') + start;
  return {
    p_timestamp: new Date(begin + durationMs).toISOString(),
    span_trace_id: trace,
    span_span_id: id,
    span_parent_span_id: parent,
    span_name: name,
    span_start_time_unix_nano: new Date(begin).toISOString(),
    span_end_time_unix_nano: new Date(begin + durationMs).toISOString(),
    span_duration_ns: durationMs * 1e6,
    span_status_code: 0,
    span_status_description: 'UNSET',
    ...fields,
  };
}
const codexTrace = '3eead3c4c7897ddb3613163ebdeaa6c0';
const codex = (id: string, parent: string, name: string, start: number, ms: number, f = {}) =>
  span(codexTrace, id, parent, name, start, ms, { 'service.name': 'codex-app-server', ...f });
const codexTurn = [
  codex('a131b912f2251684', '0d2585ff2dc6a775', 'session_task.turn', 0, 4027, {
    model: 'gpt-6-luna',
    'codex.turn.token_usage.input_tokens': '32558',
    'codex.turn.token_usage.cached_input_tokens': '27136',
    'codex.turn.token_usage.output_tokens': '38',
  }),
  codex('f29e280320d84c8e', '6e055c16cf2ba610', 'try_run_sampling_request', 100, 1648, {
    model: 'gpt-6-luna',
  }),
  codex('845411c03a89e0ff', 'f29e280320d84c8e', 'receiving_stream', 102, 1645),
  codex('5e5901e207ece80e', '845411c03a89e0ff', 'handle_responses', 1700, 38, {
    'gen_ai.usage.input_tokens': '16251',
    'gen_ai.usage.output_tokens': '33',
    'gen_ai.usage.cache_read.input_tokens': '11008',
  }),
  codex('a9a8355c5b8e769e', '174bdda1bf2f0d51', 'exec', 1760, 137, {
    tool_name: 'exec',
    call_id: 'call_vRR2GrjSnDyX8FWz50ONlZqM',
  }),
  codex('ff4f6fbba143b1c0', '638f0e6a3947c618', 'try_run_sampling_request', 2900, 967, {
    model: 'gpt-6-luna',
  }),
  codex('761175078dbf3f02', 'ff4f6fbba143b1c0', 'receiving_stream', 2902, 965),
  codex('297376cdba4bc3cc', '761175078dbf3f02', 'handle_responses', 3800, 37, {
    'gen_ai.usage.input_tokens': '16307',
    'gen_ai.usage.output_tokens': '5',
  }),
];
const claudeTrace = '0e638bc7089fb020dfd801f6c58a5dc6';
const claude = (id: string, parent: string, name: string, start: number, ms: number, f = {}) =>
  span(claudeTrace, id, parent, name, start, ms, { 'service.name': 'claude-code', ...f });
const claudeRequest = {
  'gen_ai.system': 'anthropic',
  'gen_ai.request.model': 'claude-haiku-4-5',
  model: 'claude-haiku-4-5',
  'llm_request.context': 'interaction',
};
const claudeInteraction = [
  claude('4b1b0ceaf03121e7', '', 'claude_code.interaction', 0, 3162, {
    'interaction.sequence': '1',
    user_prompt: '<REDACTED>',
  }),
  claude('06675bb5f58964d7', '4b1b0ceaf03121e7', 'claude_code.llm_request', 48, 1362, {
    ...claudeRequest,
    input_tokens: '9',
    cache_read_tokens: '12598',
    cache_creation_tokens: '8595',
    output_tokens: '102',
  }),
  claude('cf906dbe161dcbc5', '4b1b0ceaf03121e7', 'claude_code.tool', 1391, 43, {
    tool_name: 'Bash',
    tool_use_id: 'toolu_017FNPpeGEpbuRnKoQNMyXgb',
    'gen_ai.tool.call.id': 'toolu_017FNPpeGEpbuRnKoQNMyXgb',
  }),
  claude('c3b6fd085798feb9', 'cf906dbe161dcbc5', 'claude_code.tool.execution', 1396, 38),
  claude('8062decff7ff63cf', '4b1b0ceaf03121e7', 'claude_code.llm_request', 1448, 1707, {
    ...claudeRequest,
    input_tokens: '8',
    cache_read_tokens: '21193',
    cache_creation_tokens: '151',
    output_tokens: '52',
  }),
];

describe('coding-agent harness detection', () => {
  it('recognizes Codex and Claude Code trace schemas without GenAI agent fields', () => {
    const codexFields = ['span_name', 'service.name', 'codex.turn.token_usage.input_tokens'];
    expect(detectAgentHarness(codexFields)).toBe('codex');
    expect(isAgentSchema(codexFields)).toBe(true);
    expect(detectAgentHarness(['span_name', 'interaction.sequence'])).toBe('claude-code');
    // Logs carry no span names and cannot be grouped into runs.
    expect(detectAgentHarness(['codex.turn.token_usage.input_tokens'])).toBeUndefined();
    expect(detectAgentHarness(['span_name', 'model', 'tool_name'])).toBeUndefined();
  });
  it('seeds Codex runs from turns and loads only run spans from Codex services', () => {
    const fields = [
      'p_timestamp',
      'span_trace_id',
      'span_name',
      'service.name',
      'tool_name',
      'gen_ai.usage.input_tokens',
      'codex.turn.token_usage.input_tokens',
    ];
    const { sql } = buildAgentRunQuery('codex', fields, {
      startTime: '2026-10-13T00:00:00Z',
      endTime: '2026-10-14T00:00:00Z',
    });
    expect(sql).toContain(
      `AND ("span_name" = 'session_task.turn') AND "span_trace_id" IS NOT NULL`,
    );
    expect(sql).toContain(
      `AND NOT (COALESCE("service.name", '') LIKE 'codex%' AND NOT (COALESCE("span_name", '') IN ('session_task.turn', 'try_run_sampling_request', 'receiving_stream') OR (COALESCE("span_name", '') = 'handle_responses' AND "gen_ai.usage.input_tokens" IS NOT NULL) OR "tool_name" IS NOT NULL)) ORDER BY`,
    );
    // Absent columns are never referenced.
    const sparse = buildAgentRunQuery(
      'codex',
      ['p_timestamp', 'span_trace_id', 'span_name', 'service.name', 'codex.turn.phase'],
      { startTime: '2026-10-13T00:00:00Z', endTime: '2026-10-14T00:00:00Z' },
    ).sql;
    expect(sparse).not.toContain('tool_name');
    expect(sparse).not.toContain('gen_ai.usage');
  });
  it('keeps every Claude Code span and seeds runs from interactions or model calls', () => {
    const { sql } = buildAgentRunQuery(
      'claude',
      [
        'p_timestamp',
        'span_trace_id',
        'span_name',
        'service.name',
        'gen_ai.request.model',
        'interaction.sequence',
      ],
      { startTime: '2026-10-13T00:00:00Z', endTime: '2026-10-14T00:00:00Z' },
    );
    expect(sql).toContain(
      `("gen_ai.request.model" IS NOT NULL OR "span_name" = 'claude_code.interaction')`,
    );
    expect(sql).not.toContain('COALESCE');
  });
});

describe('coding-agent harness mapping', () => {
  it('builds a Codex turn with its model calls, tool call and per-request usage', () => {
    const rows = mapHarnessRows('codex', codexTurn);
    const [run] = buildAgentRuns(rows);
    expect(run.name).toBe('Codex');
    expect(run.status).toBe('success');
    expect(run.warnings).toEqual([]);
    expect(run.models).toEqual(['gpt-6-luna']);
    // Per-request usage sums to the turn's own total; the rollup is not added twice.
    expect([run.inputTokens, run.outputTokens]).toEqual([32558, 38]);
    expect(run.roots).toHaveLength(1);
    expect(run.roots[0].kind).toBe('agent');
    expect(
      run.roots[0].children.map((child) => [child.kind, child.name, child.inputTokens]),
    ).toEqual([
      ['model', 'try_run_sampling_request', 16251],
      ['tool', 'exec', undefined],
      ['model', 'try_run_sampling_request', 16307],
    ]);
    expect(run.roots[0].children[1].toolName).toBe('exec');
    expect(run.roots[0].children[1].durationMs).toBe(137);
    expect(run.spans.some((entry) => entry.name === 'handle_responses')).toBe(false);
  });
  it('shows recorded Codex fields unchanged and does not modify the query result', () => {
    const original = structuredClone(codexTurn);
    const rows = mapHarnessRows('codex', codexTurn);
    expect(codexTurn).toEqual(original);
    const tool = rows.find((row) => row.span_name === 'exec')!;
    expect(tool['gen_ai.tool.name']).toBe('exec');
    expect(tool.span_parent_span_id).toBe('a131b912f2251684');
    expect(mappedHarness(tool)).toBe('codex');
    expect(recordedFields(tool)).toEqual(original[4]);
    expect(recordedFields(original[0])).toBe(original[0]);
  });
  it('never replaces recorded GenAI values', () => {
    const [turn] = mapHarnessRows('codex', [
      { ...codexTurn[0], 'gen_ai.agent.name': 'Reviewer', 'gen_ai.usage.input_tokens': 7 },
    ]);
    expect(turn['gen_ai.agent.name']).toBe('Reviewer');
    expect(turn['gen_ai.usage.input_tokens']).toBe(7);
  });
  it('does not attach detached spans to one of several turns in a trace', () => {
    const second = { ...codexTurn[0], span_span_id: 'b131b912f2251684' };
    const rows = mapHarnessRows('codex', [...codexTurn, second]);
    expect(rows.find((row) => row.span_name === 'exec')!.span_parent_span_id).toBe(
      '174bdda1bf2f0d51',
    );
    expect(buildAgentRuns(rows)[0].warnings).toContain(
      'A parent span is outside the captured sample or missing.',
    );
  });
  it('builds a Claude Code interaction with cache-inclusive input usage and tool names', () => {
    const [run] = buildAgentRuns(mapHarnessRows('claude-code', claudeInteraction));
    expect(run.name).toBe('Claude Code');
    expect(run.status).toBe('success');
    expect(run.models).toEqual(['claude-haiku-4-5']);
    expect([run.inputTokens, run.outputTokens]).toEqual([9 + 12598 + 8595 + 8 + 21193 + 151, 154]);
    expect(
      run.roots[0].children.map((child) => [child.kind, child.toolName ?? child.model]),
    ).toEqual([
      ['model', 'claude-haiku-4-5'],
      ['tool', 'Bash'],
      ['model', 'claude-haiku-4-5'],
    ]);
    expect(run.roots[0].children[1].children[0].kind).toBe('span');
  });
  it('keeps absent Claude Code usage unknown', () => {
    const [request] = mapHarnessRows('claude-code', [
      claude('0997d8a433ad3456', '', 'claude_code.llm_request', 0, 834, claudeRequest),
    ]);
    expect(request['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(request['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(buildAgentRuns([request])[0].inputTokens).toBeUndefined();
  });
  it('leaves rows untouched when no harness is detected', () => {
    expect(mapHarnessRows(undefined, codexTurn)).toBe(codexTurn);
  });
});
