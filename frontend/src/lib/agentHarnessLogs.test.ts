import { describe, expect, it } from 'vitest';
import { mapHarnessRows } from './agentHarnesses';
import {
  attachHarnessConversation,
  buildHarnessLogQuery,
  detectHarnessLogs,
  pairedLogsDataset,
} from './agentHarnessLogs';
import { buildAgentRuns, type AgentRun } from './agentRuns';
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
      `SELECT * FROM "codex""logs" WHERE "p_timestamp" >= TIMESTAMP '2026-10-13T03:00:00.000Z' AND "p_timestamp" < TIMESTAMP '2026-10-13T04:00:00.000Z' AND "trace_id" IN ('${codexTrace}', 'x'' OR ''1''=''1') AND "event.name" IN ('codex.user_prompt', 'codex.tool_result', 'codex.tool_decision') ORDER BY "p_timestamp" ASC LIMIT 1000`,
    );
    expect(
      buildHarnessLogQuery('logs', 'codex', [], {
        startTime: '2026-10-13T03:00:00Z',
        endTime: '2026-10-13T04:00:00Z',
      }),
    ).toBeUndefined();
  });
});

describe('coding-agent conversation', () => {
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
