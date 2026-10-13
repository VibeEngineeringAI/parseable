import { describe, expect, it, vi } from 'vitest';
import { mapHarnessRows } from './agentHarnesses';
import {
  attachHarnessConversation,
  buildHarnessLogQuery,
  detectHarnessLogs,
  discoverHarnessLogs,
  pairedLogsDataset,
} from './agentHarnessLogs';
import { buildAgentRuns, type AgentRun } from './agentRuns';
import { AGENT_RECORD_LIMIT } from './agents';
import { ApiError } from './apiError';
import { createDemoClient } from './demo';
import type { LogRecord } from './types';

// Trimmed from logs exported by Codex CLI 0.162.1 (`codex exec`, log_user_prompt
// on) and Claude Code 2.1.296 (OTEL_LOG_USER_PROMPTS, _ASSISTANT_RESPONSES,
// _TOOL_DETAILS and _TOOL_CONTENT on), as stored by Parseable.
const at = (seconds: number) => new Date(Date.parse('2026-10-13T03:38:00Z') + seconds * 1000);
const stamp = (seconds: number) => at(seconds).toISOString().replace('Z', '');
function span(
  trace: string,
  id: string,
  parent: string,
  name: string,
  start: number,
  duration: number,
  fields: LogRecord = {},
): LogRecord {
  return {
    p_timestamp: stamp(start + duration),
    span_trace_id: trace,
    span_span_id: id,
    span_parent_span_id: parent,
    span_name: name,
    span_start_time_unix_nano: stamp(start),
    span_end_time_unix_nano: stamp(start + duration),
    span_duration_ns: duration * 1e9,
    span_status_code: 0,
    ...fields,
  };
}
const conversations = (run: AgentRun) =>
  run.spans
    .filter((entry) => entry.conversation.length)
    .map((entry) => [entry.name, entry.conversation.map((item) => [item.label, item.value])]);

const codexTrace = '1b1ef19838e4d610208a394b9af94384';
const codexRuns = () =>
  buildAgentRuns(
    mapHarnessRows(
      ['codex'],
      [
        span(codexTrace, 'fe5417199aa59ebf', '57d7ac8056fe8b6d', 'session_task.turn', 15.8, 4, {
          'service.name': 'codex_exec',
          model: 'gpt-6-luna',
        }),
        span(codexTrace, '67c205c2bacb4518', 'e0d1c4f0b19c5a7e', 'exec', 18, 0.2, {
          'service.name': 'codex_exec',
          tool_name: 'exec',
          call_id: 'call_7b616c08bc894640a843cff3e0f7b38a',
        }),
      ],
    ),
  );
const codexLog = (fields: LogRecord): LogRecord => ({
  'service.name': 'codex_exec',
  'conversation.id': '01a13356-e711-7291-829d-0051eaa8578d',
  model: 'gpt-6-luna',
  trace_id: codexTrace,
  ...fields,
});
const codexTurns = (
  ranges = [
    [15.8, 4],
    [25.8, 4],
  ],
) =>
  buildAgentRuns(
    mapHarnessRows(
      ['codex'],
      ranges.map(([start, duration], index) =>
        span(codexTrace, `turn-${index}`, '', 'session_task.turn', start, duration, {
          'service.name': 'codex_exec',
        }),
      ),
    ),
  );
const codexLogs = [
  codexLog({
    'event.name': 'codex.user_prompt',
    'event.timestamp': stamp(15.79),
    span_id: '57d7ac8056fe8b6d',
    prompt: 'Run: cat sample.txt  then reply with just the file contents.',
  }),
  codexLog({
    'event.name': 'codex.tool_result',
    'event.timestamp': stamp(18.23),
    span_id: '07d5bd18e22b0db8',
    call_id: 'call_7b616c08bc894640a843cff3e0f7b38a',
    tool_name: 'exec',
    arguments: 'const r = await tools.exec_command({cmd:"cat sample.txt"});\ntext(r.output);\n',
    output: 'Script completed\nWall time 0.2 seconds\nOutput:\n\nhello\n',
  }),
  // Code-mode tool calls run in a separate trace that has no turn.
  codexLog({
    'event.name': 'codex.tool_result',
    'event.timestamp': stamp(18.22),
    trace_id: 'b5039406affbf2550d35a030cd3f6986',
    span_id: 'f77605377c432cde',
    call_id: 'exec-65b04fe7-d62b-4d47-9411-ef6a1c283dde',
    tool_name: 'exec_command',
    output: 'hello\n',
  }),
];

const claudeTrace = '677fd41f03b0e3928c18d90bd38a609c';
const claudeSpan = (id: string, parent: string, name: string, start: number, ms: number, f = {}) =>
  span(claudeTrace, id, parent, name, start, ms, {
    'service.name': 'claude-code',
    'interaction.sequence': '1',
    ...f,
  });
const claudeRequest = (id: string, start: number) =>
  claudeSpan(id, '671ed833b6b2a759', 'claude_code.llm_request', start, 2.8, {
    'gen_ai.request.model': 'claude-haiku-4-5',
    'gen_ai.response.id': `req_${id}`,
    request_id: `req_${id}`,
  });
const claudeToolSpan = claudeSpan(
  '45801e168f0029ae',
  '671ed833b6b2a759',
  'claude_code.tool',
  12.42,
  0.05,
  { tool_name: 'Bash', tool_use_id: 'toolu_01HvwCWjo8bJsGSinB2vRVrx' },
);
const claudeToolOutput = {
  ...claudeToolSpan,
  event_name: 'tool.output',
  event_time_unix_nano: stamp(12.47),
  event_output: 'hello',
  event_bash_command: 'cat sample.txt',
};
const claudeRuns = () =>
  buildAgentRuns(
    mapHarnessRows(
      ['claude-code'],
      [
        claudeSpan('671ed833b6b2a759', '', 'claude_code.interaction', 9.5, 6),
        claudeRequest('first', 9.6),
        claudeToolSpan,
        // Flattened span events repeat; the output is shown once.
        claudeToolOutput,
        { ...claudeToolOutput },
        claudeRequest('second', 12.5),
      ],
    ),
  );
const claudeLog = (sequence: number, seconds: number, fields: LogRecord): LogRecord => ({
  'service.name': 'claude-code',
  'session.id': 'bf8fbff9-ba17-486f-9385-b22d997bf213',
  'prompt.id': 'c0c7a199-8d62-4a46-9575-2654870f8ad0',
  'event.sequence': String(sequence),
  'event.timestamp': stamp(seconds),
  trace_id: claudeTrace,
  span_id: '671ed833b6b2a759',
  ...fields,
});
const claudeLogs = [
  claudeLog(4, 9.52, {
    'event.name': 'user_prompt',
    prompt: 'Run cat sample.txt with the Bash tool, then reply with just the file contents.\n',
  }),
  claudeLog(8, 12.428, {
    'event.name': 'tool_decision',
    span_id: '55648ab0912c53ee',
    decision: 'accept',
    source: 'config',
    tool_name: 'Bash',
    tool_use_id: 'toolu_01HvwCWjo8bJsGSinB2vRVrx',
  }),
  // Logged when the tool finished; its input belongs before the output.
  claudeLog(10, 12.471, {
    'event.name': 'tool_result',
    duration_ms: '42',
    tool_name: 'Bash',
    tool_use_id: 'toolu_01HvwCWjo8bJsGSinB2vRVrx',
    tool_input: '{"command":"cat sample.txt"}',
  }),
  claudeLog(12, 15.358, {
    'event.name': 'assistant_response',
    request_id: 'req_second',
    response: 'hello',
  }),
  claudeLog(13, 15.4, {
    'event.name': 'assistant_response',
    request_id: 'req_not_loaded',
    response: '<REDACTED>',
  }),
];

describe('coding-agent logs datasets', () => {
  it('recognizes Codex and Claude Code logs, but not their traces', () => {
    const logs = ['event.name', 'trace_id', 'span_id'];
    expect(detectHarnessLogs([...logs, 'conversation.id', 'originator'])).toBe('codex');
    expect(detectHarnessLogs([...logs, 'prompt.id', 'event.sequence'])).toBe('claude-code');
    expect(
      detectHarnessLogs([...logs, 'prompt.id', 'event.sequence', 'span_name']),
    ).toBeUndefined();
    expect(detectHarnessLogs(['event.name', 'conversation.id', 'originator'])).toBeUndefined();
  });
  it('pairs a traces dataset with the logs dataset named like it', () => {
    expect(pairedLogsDataset('codex-traces', ['archive', 'codex-logs'])).toBe('codex-logs');
    expect(pairedLogsDataset('claude_trace', ['claude_log', 'z'])).toBe('claude_log');
    expect(pairedLogsDataset('agents', ['z-logs', 'a-logs'])).toBe('a-logs');
  });
  it('queries only conversation events for the loaded traces with quoted values', () => {
    const query = buildHarnessLogQuery(
      'codex"logs',
      'codex',
      [codexTrace, "x' OR '1'='1", codexTrace, ' '],
      { startTime: '2026-10-13T03:00:00Z', endTime: '2026-10-13T04:00:00Z' },
    )!;
    expect(query.sql).toBe(
      `SELECT * FROM "codex""logs" WHERE "p_timestamp" >= TIMESTAMP '2026-10-13T03:00:00.000Z' AND "p_timestamp" < TIMESTAMP '2026-10-13T04:00:00.000Z' AND "trace_id" IN ('${codexTrace}', 'x'' OR ''1''=''1') AND "event.name" IN ('codex.user_prompt', 'codex.tool_result', 'codex.tool_decision') ORDER BY "p_timestamp" DESC LIMIT ${AGENT_RECORD_LIMIT}`,
    );
    expect(
      buildHarnessLogQuery('logs', 'codex', [], {
        startTime: '2026-10-13T03:00:00Z',
        endTime: '2026-10-13T04:00:00Z',
      }),
    ).toBeUndefined();
  });
});

describe('harness logs discovery', () => {
  const codexFields = ['event.name', 'trace_id', 'conversation.id', 'originator'];
  const clientFor = (names: string[]) => ({
    ...createDemoClient(),
    listDatasets: vi.fn(async () => names.map((name) => ({ name, type: 'logs' as const }))),
    schema: vi.fn(async (_name: string, _signal?: AbortSignal) => codexFields),
  });

  it('discovers both harnesses in one scan and excludes non-logs datasets', async () => {
    const client = clientFor(['codex-logs', 'claude-logs', 'traces', 'other']);
    client.schema.mockImplementation(async (name) => {
      if (name === 'claude-logs') return ['event.name', 'trace_id', 'prompt.id', 'event.sequence'];
      if (name === 'traces') return [...codexFields, 'span_name'];
      if (name === 'other') return ['p_timestamp', 'message'];
      return codexFields;
    });
    const signal = new AbortController().signal;
    await expect(discoverHarnessLogs(client, signal)).resolves.toEqual({
      datasets: [
        { name: 'codex-logs', harness: 'codex' },
        { name: 'claude-logs', harness: 'claude-code' },
      ],
      unchecked: [],
    });
    expect(client.listDatasets).toHaveBeenCalledExactlyOnceWith(signal);
    expect(client.schema).toHaveBeenCalledTimes(4);
    for (const name of ['codex-logs', 'claude-logs', 'traces', 'other'])
      expect(client.schema).toHaveBeenCalledWith(name, signal);
  });

  it.each([403, 404])('silently skips schema status %s', async (status) => {
    const client = clientFor(['allowed', 'skipped']);
    client.schema.mockImplementation(async (name) => {
      if (name === 'skipped') throw new ApiError('Cannot read', status);
      return codexFields;
    });
    await expect(discoverHarnessLogs(client)).resolves.toEqual({
      datasets: [{ name: 'allowed', harness: 'codex' }],
      unchecked: [],
    });
  });

  it('reports unavailable schemas while keeping discovered datasets', async () => {
    const client = clientFor(['allowed', 'unavailable']);
    client.schema.mockImplementation(async (name) => {
      if (name === 'unavailable') throw new ApiError('Unavailable', 503);
      return codexFields;
    });
    await expect(discoverHarnessLogs(client)).resolves.toEqual({
      datasets: [{ name: 'allowed', harness: 'codex' }],
      unchecked: [{ name: 'unavailable', error: 'Unavailable' }],
    });
  });

  it('reports non-Error schema failures', async () => {
    const client = clientFor(['unavailable']);
    client.schema.mockRejectedValue('Connection lost');
    await expect(discoverHarnessLogs(client)).resolves.toEqual({
      datasets: [],
      unchecked: [{ name: 'unavailable', error: 'Connection lost' }],
    });
  });

  it('rethrows expired sessions', async () => {
    const client = clientFor(['logs']);
    const error = new ApiError('Expired', 401);
    client.schema.mockRejectedValue(error);
    await expect(discoverHarnessLogs(client)).rejects.toBe(error);
  });

  it('rethrows dataset listing failures without scanning schemas', async () => {
    const client = clientFor(['logs']);
    const error = new ApiError('Unavailable', 503);
    client.listDatasets.mockRejectedValue(error);
    await expect(discoverHarnessLogs(client)).rejects.toBe(error);
    expect(client.schema).not.toHaveBeenCalled();
  });

  it('rethrows an aborted schema request', async () => {
    const client = clientFor(['logs']);
    const controller = new AbortController();
    const error = new DOMException('Aborted', 'AbortError');
    client.schema.mockImplementation(async () => {
      controller.abort(error);
      throw error;
    });
    await expect(discoverHarnessLogs(client, controller.signal)).rejects.toBe(error);
  });
});

describe('coding-agent conversation', () => {
  it('restores time and sequence order for a full descending page of logs', () => {
    const prompts = Array.from({ length: AGENT_RECORD_LIMIT + 1 }, (_, index) =>
      codexLog({
        'event.name': 'codex.user_prompt',
        'event.timestamp': stamp(16 + Math.floor(index / 2) / 1000),
        'event.sequence': index,
        prompt: `Prompt ${index}`,
      }),
    );
    const newest = [...prompts].reverse().slice(0, AGENT_RECORD_LIMIT);
    const [run] = attachHarnessConversation(codexRuns(), 'codex', newest);
    expect(run.roots[0].conversation.map((entry) => entry.value)).toEqual(
      prompts.slice(1).map((row) => row.prompt),
    );
  });

  it('puts the Codex prompt on its turn and tool calls on their tool span', () => {
    const [run] = attachHarnessConversation(codexRuns(), 'codex', codexLogs);
    expect(conversations(run)).toEqual([
      [
        'session_task.turn',
        [['User prompt', 'Run: cat sample.txt  then reply with just the file contents.']],
      ],
      [
        'exec',
        [
          ['Tool arguments · exec', codexLogs[1].arguments],
          ['Tool output · exec', codexLogs[1].output],
        ],
      ],
    ]);
  });
  it('assigns prompts to their turns, including a lead before the turn and the turn end', () => {
    const [run] = attachHarnessConversation(codexTurns(), 'codex', [
      codexLog({
        'event.name': 'codex.user_prompt',
        'event.timestamp': stamp(15.79),
        span_id: 'turn-input-0',
        prompt: 'first',
      }),
      codexLog({
        'event.name': 'codex.user_prompt',
        'event.timestamp': stamp(29.8),
        span_id: 'turn-input-1',
        prompt: 'second',
      }),
    ]);
    expect(run.spans.map((span) => span.conversation)).toEqual([
      [{ label: 'User prompt', value: 'first' }],
      [{ label: 'User prompt', value: 'second' }],
    ]);
  });
  it('leaves unmatched prompts unattached when several turns are loaded', () => {
    const [run] = attachHarnessConversation(
      codexTurns(),
      'codex',
      [14.7, 22, undefined].map((seconds) =>
        codexLog({
          'event.name': 'codex.user_prompt',
          'event.timestamp': seconds === undefined ? undefined : stamp(seconds),
          prompt: 'unmatched',
        }),
      ),
    );
    expect(conversations(run)).toEqual([]);
  });
  it('does not give a later turn prompt to the only loaded turn', () => {
    // The second turn is still running, so its span has not been exported.
    const [run] = attachHarnessConversation(codexTurns([[15.8, 4]]), 'codex', [
      codexLog({
        'event.name': 'codex.user_prompt',
        'event.timestamp': stamp(25.79),
        prompt: 'later',
      }),
    ]);
    expect(conversations(run)).toEqual([]);
  });
  it('attributes prompts to Codex turns under an agent span of another service', () => {
    const rows = [
      span(codexTrace, 'orchestrator0001', '', 'orchestrate', 10, 30, {
        'service.name': 'orchestrator',
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': 'Orchestrator',
      }),
      ...[15.8, 25.8].map((start, index) =>
        span(codexTrace, `turn-${index}`, 'orchestrator0001', 'session_task.turn', start, 4, {
          'service.name': 'codex_exec',
        }),
      ),
    ];
    const [run] = attachHarnessConversation(
      buildAgentRuns(mapHarnessRows(['codex'], rows)),
      'codex',
      [15.79, 25.79].map((seconds, index) =>
        codexLog({
          'event.name': 'codex.user_prompt',
          'event.timestamp': stamp(seconds),
          prompt: `prompt ${index}`,
        }),
      ),
    );
    expect(conversations(run).map(([, items]) => items)).toEqual([
      [['User prompt', 'prompt 0']],
      [['User prompt', 'prompt 1']],
    ]);
  });
  it('falls back to the only turn, not an enclosing span of another service', () => {
    const rows = [
      span(codexTrace, 'cijob00000000001', '', 'ci.job', 0, 60, { 'service.name': 'ci' }),
      span(codexTrace, 'turn-0', 'cijob00000000001', 'session_task.turn', 15.8, 4, {
        'service.name': 'codex_exec',
      }),
    ];
    const [run] = attachHarnessConversation(
      buildAgentRuns(mapHarnessRows(['codex'], rows)),
      'codex',
      [codexLog({ 'event.name': 'codex.user_prompt', prompt: 'untimed' })],
    );
    expect(run.spans.find((entry) => entry.spanId === 'turn-0')!.conversation).toEqual([
      { label: 'User prompt', value: 'untimed' },
    ]);
  });
  it('gives each prompt to the turn starting right after it, even for close turns', () => {
    const prompts = (...seconds: number[]) =>
      seconds.map((value, index) =>
        codexLog({
          'event.name': 'codex.user_prompt',
          'event.timestamp': stamp(value),
          span_id: `turn-input-${index}`,
          prompt: `prompt ${index}`,
        }),
      );
    const [close] = attachHarnessConversation(
      codexTurns([
        [10, 0.2],
        [10.7, 0.2],
      ]),
      'codex',
      prompts(9.99, 10.69),
    );
    expect(close.spans.map((span) => span.conversation)).toEqual([
      [{ label: 'User prompt', value: 'prompt 0' }],
      [{ label: 'User prompt', value: 'prompt 1' }],
    ]);
    // The prompt of an earlier, unloaded turn stays unattached.
    const [later] = attachHarnessConversation(
      codexTurns([
        [10.7, 0.2],
        [15, 0.2],
      ]),
      'codex',
      prompts(9.99),
    );
    expect(conversations(later)).toEqual([]);
  });
  it('leaves prompts unattached when turn ranges overlap', () => {
    const [run] = attachHarnessConversation(
      codexTurns([
        [15.8, 4],
        [17, 4],
      ]),
      'codex',
      [
        codexLog({
          'event.name': 'codex.user_prompt',
          'event.timestamp': stamp(18),
          prompt: 'ambiguous',
        }),
      ],
    );
    expect(conversations(run)).toEqual([]);
  });
  it('does not fall back to a tool root when no agent turn is loaded', () => {
    const runs = buildAgentRuns(mapHarnessRows(['codex'], [codexRuns()[0].spans[1].row]));
    const [run] = attachHarnessConversation(runs, 'codex', [codexLogs[0]]);
    expect(conversations(run)).toEqual([]);
  });
  it('falls back to the root for an unmatched prompt only with one agent turn', () => {
    const [run] = attachHarnessConversation(codexTurns([[15.8, 4]]), 'codex', [
      codexLog({ 'event.name': 'codex.user_prompt', prompt: 'single turn' }),
    ]);
    expect(run.roots[0].conversation).toEqual([{ label: 'User prompt', value: 'single turn' }]);
  });
  it('uses the same turn fallback for tool records without a loaded tool', () => {
    const [run] = attachHarnessConversation(codexTurns(), 'codex', [
      codexLog({
        'event.name': 'codex.tool_result',
        'event.timestamp': stamp(26),
        output: 'second turn',
      }),
      codexLog({
        'event.name': 'codex.tool_decision',
        'event.timestamp': stamp(22),
        decision: 'unmatched',
      }),
    ]);
    expect(run.spans.map((span) => span.conversation)).toEqual([
      [],
      [{ label: 'Tool output', value: 'second turn' }],
    ]);
  });
  it.each([false, true])('scopes shared call IDs by trace (own tool span: %s)', (own) => {
    const rows = [codexTrace, 'other-trace'].flatMap((trace) =>
      codexRuns()[0].spans.map((span) => ({ ...span.row, span_trace_id: trace })),
    );
    const logs = [codexTrace, 'other-trace'].map((trace) => ({
      ...codexLogs[1],
      trace_id: trace,
      span_id: own ? '67c205c2bacb4518' : 'not-loaded',
      arguments: undefined,
      output: trace,
    }));
    const runs = attachHarnessConversation(
      buildAgentRuns(mapHarnessRows(['codex'], rows)),
      'codex',
      logs,
    );
    for (const run of runs)
      expect(run.spans.find((span) => span.kind === 'tool')?.conversation).toEqual([
        { label: 'Tool output · exec', value: run.traceId },
      ]);
  });
  it.each(['codex.tool_result', 'tool_result', 'codex.tool_decision'])(
    'prefers the own tool span over a conflicting call ID for %s',
    (event) => {
      const rows = codexRuns()[0].spans.map((span) => span.row);
      rows.push({ ...rows[1], span_span_id: 'colliding-tool' });
      const [run] = attachHarnessConversation(
        buildAgentRuns(mapHarnessRows(['codex'], rows)),
        'codex',
        [
          codexLog({
            'event.name': event,
            span_id: '67c205c2bacb4518',
            call_id: codexLogs[1].call_id,
            output: 'own tool',
            tool_input: 'own tool',
            decision: 'own tool',
          }),
        ],
      );
      expect(run.spans.find((span) => span.spanId === '67c205c2bacb4518')?.conversation).toEqual([
        {
          label:
            event === 'codex.tool_result'
              ? 'Tool output'
              : event === 'tool_result'
                ? 'Tool input'
                : 'Tool decision',
          value: 'own tool',
        },
      ]);
      expect(run.spans.find((span) => span.spanId === 'colliding-tool')?.conversation).toEqual([]);
    },
  );
  it.each(['continue', '[REDACTED]'])(
    'keeps distinct prompts with identical text: %s',
    (prompt) => {
      const [run] = attachHarnessConversation(codexRuns(), 'codex', [
        { ...codexLogs[0], prompt },
        { ...codexLogs[0], 'event.timestamp': stamp(16), prompt },
      ]);
      const item = {
        label: prompt === '[REDACTED]' ? 'User prompt (redacted)' : 'User prompt',
        value: prompt,
      };
      expect(run.roots[0].conversation).toEqual([item, item]);
    },
  );
  it('keeps identical prompts at the same time with distinct event sequences', () => {
    const [run] = attachHarnessConversation(claudeRuns(), 'claude-code', [
      claudeLog(1, 10, { 'event.name': 'user_prompt', prompt: 'continue' }),
      claudeLog(2, 10, { 'event.name': 'user_prompt', prompt: 'continue' }),
    ]);
    expect(run.roots[0].conversation).toEqual([
      { label: 'User prompt', value: 'continue' },
      { label: 'User prompt', value: 'continue' },
    ]);
  });
  it('deduplicates flattened outputs by occurrence while keeping later identical output', () => {
    const runs = claudeRuns();
    runs[0].spans
      .find((span) => span.kind === 'tool')!
      .rows.push({
        ...claudeToolOutput,
        event_time_unix_nano: stamp(12.48),
      });
    const [run] = attachHarnessConversation(runs, 'claude-code');
    expect(conversations(run)).toEqual([
      [
        'claude_code.tool',
        [
          ['Tool output · Bash', 'hello'],
          ['Tool output · Bash', 'hello'],
        ],
      ],
    ]);
  });
  it('labels redacted content instead of hiding it', () => {
    const [run] = attachHarnessConversation(codexRuns(), 'codex', [
      { ...codexLogs[0], prompt: '[REDACTED]' },
    ]);
    expect(run.roots[0].conversation).toEqual([
      { label: 'User prompt (redacted)', value: '[REDACTED]' },
    ]);
  });
  it('orders Claude Code prompts, tool activity and responses as they happened', () => {
    const [run] = attachHarnessConversation(claudeRuns(), 'claude-code', claudeLogs);
    expect(conversations(run)).toEqual([
      [
        'claude_code.interaction',
        [
          ['User prompt', claudeLogs[0].prompt],
          // A response whose model call is not loaded stays on the span that logged it.
          ['Assistant response (redacted)', '<REDACTED>'],
        ],
      ],
      [
        'claude_code.tool',
        [
          ['Tool decision · Bash', 'accept (config)'],
          ['Tool input · Bash', '{"command":"cat sample.txt"}'],
          ['Tool output · Bash', 'hello'],
        ],
      ],
      ['claude_code.llm_request', [['Assistant response', 'hello']]],
    ]);
  });
  it('shows Claude Code tool output from traces without a logs dataset', () => {
    const [run] = attachHarnessConversation(claudeRuns(), 'claude-code');
    expect(conversations(run)).toEqual([['claude_code.tool', [['Tool output · Bash', 'hello']]]]);
  });
  it('ignores records for runs that are not loaded, and other datasets', () => {
    const runs = codexRuns();
    expect(
      attachHarnessConversation(runs, 'codex', [codexLogs[2]]).flatMap((run) =>
        run.spans.flatMap((entry) => entry.conversation),
      ),
    ).toEqual([]);
    const plain = codexRuns();
    expect(attachHarnessConversation(plain, undefined, codexLogs)).toBe(plain);
    expect(plain[0].roots[0].conversation).toEqual([]);
  });
});
