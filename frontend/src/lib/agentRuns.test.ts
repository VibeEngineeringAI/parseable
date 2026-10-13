import { describe, expect, it } from 'vitest';
import { buildAgentRuns } from './agentRuns';
import { agentDemoRows } from './agents';
import type { LogRecord } from './types';

const started = Date.parse('2026-10-01T00:00:00Z');
function span(
  id: string,
  parent = '',
  offset = 0,
  duration = 1000,
  extra: LogRecord = {},
): LogRecord {
  return {
    p_timestamp: new Date(started + offset).toISOString(),
    span_trace_id: 'trace-a',
    span_span_id: id,
    span_parent_span_id: parent,
    span_name: id,
    span_start_time_unix_nano: new Date(started + offset).toISOString(),
    span_end_time_unix_nano: new Date(started + offset + duration).toISOString(),
    span_duration_ns: duration * 1e6,
    span_status_code: 1,
    ...extra,
  };
}
const modelFields = { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'example-model' };

describe('agent run telemetry normalization', () => {
  it('groups a trace with generic child spans into one run and measures elapsed duration', () => {
    const [run] = buildAgentRuns([
      span('root', '', 0, 2000, {
        'gen_ai.agent.name': 'Support',
        'gen_ai.operation.name': 'invoke_agent',
      }),
      span('chat', 'root', 100, 1000, modelFields),
      span('tool', 'root', 1000, 500, { 'gen_ai.tool.name': 'lookup' }),
      span('http', 'tool', 1050, 100, { 'http.request.method': 'GET' }),
    ]);
    expect(run.name).toBe('Support');
    expect(run.status).toBe('success');
    expect(run.durationMs).toBe(2000);
    expect(run.spans).toHaveLength(4);
    expect(run.roots).toHaveLength(1);
    expect(run.roots[0].children.map((child) => child.name)).toEqual(['chat', 'tool']);
    expect(run.roots[0].children[1].children[0].kind).toBe('span');
    expect(run.models).toEqual(['example-model']);
  });
  it('uses actual timestamps rather than adding overlapping child durations', () => {
    const [run] = buildAgentRuns([span('a', '', 0, 1000), span('b', 'a', 500, 1500)]);
    expect(run.durationMs).toBe(2000);
  });
  it('keeps traces separate even when span identifiers overlap', () => {
    const runs = buildAgentRuns([
      span('root'),
      span('root', '', 0, 1000, { span_trace_id: 'trace-b' }),
    ]);
    expect(runs).toHaveLength(2);
  });
  it('deduplicates flattened event/link rows and usage while preserving event content', () => {
    const call = span('chat', '', 0, 1000, {
      ...modelFields,
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 5,
    });
    const [run] = buildAgentRuns([
      {
        ...call,
        event_name: 'gen_ai.user.message',
        event_time_unix_nano: '2026-10-01T00:00:00Z',
        'event_gen_ai.input.messages': [{ role: 'user', content: 'Hi' }],
      },
      {
        ...call,
        event_name: 'gen_ai.assistant.message',
        event_time_unix_nano: '2026-10-01T00:00:01Z',
        'event_gen_ai.output.messages': [{ role: 'assistant', content: 'Hello' }],
      },
      { ...call, link_span_id: 'linked' },
    ]);
    expect(run.spans).toHaveLength(1);
    expect(run.inputTokens).toBe(10);
    expect(run.outputTokens).toBe(5);
    expect(run.spans[0].rows).toHaveLength(3);
    expect(run.spans[0].conversation).toHaveLength(2);
  });
  it('does not count parent token rollups twice', () => {
    const [run] = buildAgentRuns([
      span('root', '', 0, 1000, {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.usage.input_tokens': 30,
        'gen_ai.usage.output_tokens': 9,
      }),
      span('a', 'root', 10, 200, {
        ...modelFields,
        'gen_ai.usage.input_tokens': 10,
        'gen_ai.usage.output_tokens': 4,
      }),
      span('b', 'root', 300, 200, {
        ...modelFields,
        'gen_ai.usage.input_tokens': 20,
        'gen_ai.usage.output_tokens': 5,
      }),
    ]);
    expect(run.inputTokens).toBe(30);
    expect(run.outputTokens).toBe(9);
  });
  it('prefers model-call usage over agent rollups even when a parent is missing', () => {
    const [run] = buildAgentRuns([
      span('root', '', 0, 1000, {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.usage.input_tokens': 10,
      }),
      span('chat', 'missing', 100, 200, { ...modelFields, 'gen_ai.usage.input_tokens': 10 }),
    ]);
    expect(run.inputTokens).toBe(10);
    expect(run.status).toBe('incomplete');
  });
  it('distinguishes missing usage from captured zero and reports partial model usage', () => {
    const [run] = buildAgentRuns([
      span('a', '', 0, 1000, { ...modelFields, 'gen_ai.usage.input_tokens': 0 }),
      span('b', 'a', 0, 500, modelFields),
    ]);
    expect(run.inputTokens).toBe(0);
    expect(run.outputTokens).toBeUndefined();
    expect(run.warnings).toContain(
      'Token usage is partial because some model calls do not report usage.',
    );
    expect(run.spans[1].inputTokens).toBeUndefined();
  });
  it('rejects malformed, negative, fractional, or unsafe usage values', () => {
    const [run] = buildAgentRuns([
      span('a', '', 0, 1000, {
        ...modelFields,
        'gen_ai.usage.input_tokens': false,
        'gen_ai.usage.output_tokens': -1,
      }),
    ]);
    expect(run.inputTokens).toBeUndefined();
    expect(run.outputTokens).toBeUndefined();
    for (const value of ['', 'bad', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        buildAgentRuns([span('a', '', 0, 1000, { 'gen_ai.usage.input_tokens': value })])[0]
          .inputTokens,
      ).toBeUndefined();
    }
  });
  it('uses response model and historical usage aliases when provided', () => {
    const [run] = buildAgentRuns([
      span('a', '', 0, 1000, {
        'gen_ai.response.model': 'actual-model',
        'gen_ai.request.model': 'requested-model',
        'gen_ai.usage.prompt_tokens': '12',
        'gen_ai.usage.completion_tokens': '0',
      }),
    ]);
    expect(run.models).toEqual(['actual-model']);
    expect(run.inputTokens).toBe(12);
    expect(run.outputTokens).toBe(0);
  });
  it('does not invent success when status or completion telemetry is missing', () => {
    expect(
      buildAgentRuns([span('a', '', 0, 1000, { span_status_code: undefined })])[0].status,
    ).toBe('incomplete');
    expect(
      buildAgentRuns([span('a', '', 0, 1000, { span_end_time_unix_nano_epoch: 0 })])[0].status,
    ).toBe('incomplete');
    expect(
      buildAgentRuns([
        span('a', '', 0, 1000, { span_end_time_unix_nano: undefined, span_duration_ns: undefined }),
      ])[0].status,
    ).toBe('incomplete');
  });
  it('recognizes completed OTEL UNSET spans without assuming open spans succeeded', () => {
    expect(buildAgentRuns([span('a', '', 0, 1000, { span_status_code: 0 })])[0].status).toBe(
      'success',
    );
    expect(buildAgentRuns([span('a', '', 0, 1000, { span_status_code: 'UNSET' })])[0].status).toBe(
      'success',
    );
    expect(
      buildAgentRuns([
        span('a', '', 0, 1000, { span_status_code: 0, span_end_time_unix_nano: undefined }),
      ])[0].status,
    ).toBe('incomplete');
  });
  it('uses a completed root agent outcome when a failed child tool was recovered', () => {
    const [run] = buildAgentRuns([
      span('tool', 'root', 100, 100, {
        'gen_ai.tool.name': 'lookup',
        span_status_code: 2,
        span_status_message: 'Recovered timeout',
      }),
      span('root', '', 0, 1000, {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': 'Support',
      }),
    ]);
    expect(run.status).toBe('success');
    expect(run.spans[0].status).toBe('failed');
    expect(run.spans[0].errors).toEqual(['Recovered timeout']);
    expect(run.warnings).toContain(
      'Child spans reported errors; captured errors remain available in run details.',
    );
  });
  it('fails the whole trace when the non-agent ancestor fails above a completed agent', () => {
    const [run] = buildAgentRuns([
      span('http', '', 0, 1500, {
        span_name: 'POST /chat',
        span_status_code: 2,
        span_status_message: 'Response failed',
      }),
      span('agent', 'http', 100, 1000, {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': 'Support',
      }),
    ]);
    expect(run.status).toBe('failed');
    expect(run.spans[1].status).toBe('success');
    expect(run.warnings).toContain(
      'Spans outside the agent subtree reported errors; captured errors remain available in run details.',
    );
    expect(run.warnings).not.toContain(
      'Child spans reported errors; captured errors remain available in run details.',
    );
  });
  it('fails the whole trace when a separate tool root fails alongside a completed agent', () => {
    const [run] = buildAgentRuns([
      span('agent', '', 0, 1000, {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': 'Support',
      }),
      span('tool', '', 100, 100, {
        'gen_ai.tool.name': 'lookup',
        span_status_code: 2,
        span_status_message: 'Unhandled tool failure',
      }),
    ]);
    expect(run.status).toBe('failed');
    expect(run.roots).toHaveLength(2);
    expect(run.warnings).toContain(
      'Spans outside the agent subtree reported errors; captured errors remain available in run details.',
    );
    expect(run.warnings).not.toContain(
      'Child spans reported errors; captured errors remain available in run details.',
    );
  });
  it('keeps a completed agent run incomplete while its HTTP ancestor is unfinished', () => {
    const [run] = buildAgentRuns([
      span('http', '', 0, 1500, { span_end_time_unix_nano_epoch: 0 }),
      span('agent', 'http', 100, 1000, { 'gen_ai.operation.name': 'invoke_agent' }),
    ]);
    expect(run.status).toBe('incomplete');
    expect(run.spans[1].status).toBe('success');
  });
  it('keeps a completed agent run incomplete when a separate root lacks status', () => {
    const [run] = buildAgentRuns([
      span('agent', '', 0, 1000, { 'gen_ai.operation.name': 'invoke_agent' }),
      span('other', '', 100, 100, { span_status_code: undefined }),
    ]);
    expect(run.status).toBe('incomplete');
    expect(run.roots).toHaveLength(2);
  });
  it('allows an explicitly completed agent to certify its own unfinished child', () => {
    const [run] = buildAgentRuns([
      span('agent', '', 0, 1000, { 'gen_ai.operation.name': 'invoke_agent' }),
      span('tool', 'agent', 100, 100, { span_end_time_unix_nano_epoch: 0 }),
    ]);
    expect(run.status).toBe('success');
    expect(run.spans[1].status).toBe('incomplete');
  });
  it('describes error spans without an authoritative agent without calling them child errors', () => {
    const [run] = buildAgentRuns([span('root', '', 0, 100, { span_status_code: 2 })]);
    expect(run.status).toBe('failed');
    expect(run.warnings).toContain(
      'Spans reported errors; captured errors remain available in run details.',
    );
    expect(run.warnings).not.toContain(
      'Child spans reported errors; captured errors remain available in run details.',
    );
  });
  it('keeps failed and incomplete root agent outcomes authoritative', () => {
    const failedChild = span('tool', 'root', 100, 100, {
      'gen_ai.tool.name': 'lookup',
      span_status_code: 2,
    });
    const root = span('root', '', 0, 1000, {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'Support',
    });
    expect(buildAgentRuns([{ ...root, span_status_code: 2 }, span('tool', 'root')])[0].status).toBe(
      'failed',
    );
    expect(
      buildAgentRuns([{ ...root, span_end_time_unix_nano_epoch: 0 }, failedChild])[0].status,
    ).toBe('incomplete');
    // UNSET does not certify recovery from a failed child the way explicit OK does.
    expect(buildAgentRuns([{ ...root, span_status_code: 0 }, failedChild])[0].status).toBe(
      'failed',
    );
  });
  it('does not turn a captured exception event into failure when the span explicitly completed OK', () => {
    const [run] = buildAgentRuns([
      span('root', '', 0, 1000, {
        'gen_ai.operation.name': 'invoke_agent',
        event_name: 'exception',
        'event_exception.message': 'Retry succeeded',
      }),
    ]);
    expect(run.status).toBe('success');
    expect(run.spans[0].errors).toEqual(['Retry succeeded']);
    expect(run.warnings).toContain('The completed agent span contains captured error events.');
  });
  it('labels runs beginning before the selected ingestion window as incomplete coverage', () => {
    const [run] = buildAgentRuns([span('root')], 'p_timestamp', {
      bounds: { startTime: '2026-10-01T00:00:00.500Z', endTime: '2026-10-01T00:01:00Z' },
    });
    expect(run.status).toBe('incomplete');
    expect(run.warnings).toContain(
      'This run started before the selected ingestion-time range; earlier telemetry may be missing.',
    );
  });
  it('names the run after its shallowest agent instead of the first flattened row', () => {
    const [run] = buildAgentRuns([
      span('child', 'root', 100, 100, {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': 'Nested helper',
      }),
      span('root', '', 0, 1000, {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': 'Main agent',
      }),
    ]);
    expect(run.name).toBe('Main agent');
  });
  it('supports safely typed token siblings and OpenInference aliases', () => {
    const [run] = buildAgentRuns([
      span('model', '', 0, 100, {
        ...modelFields,
        'gen_ai.usage.input_tokens_int64': '12',
        'gen_ai.usage.output_tokens_float64': 0,
      }),
      span('alias', '', 200, 100, {
        ...modelFields,
        'llm.token_count.prompt': 8,
        'llm.token_count.completion': 3,
      }),
    ]);
    expect(run.inputTokens).toBe(20);
    expect(run.outputTokens).toBe(3);
    expect(
      buildAgentRuns([
        span('bad', '', 0, 100, {
          'gen_ai.usage.input_tokens_bool': true,
          'gen_ai.usage.output_tokens_float64': 1.5,
        }),
      ])[0].inputTokens,
    ).toBeUndefined();
    expect(
      buildAgentRuns([
        span('bad', '', 0, 100, { 'gen_ai.usage.input_tokens_int64': '9007199254740992' }),
      ])[0].inputTokens,
    ).toBeUndefined();
  });
  it('treats explicit zero end timestamp as incomplete and does not show saturated zero duration', () => {
    const [run] = buildAgentRuns([
      span('a', '', 0, 1000, {
        span_end_time_unix_nano: '1970-01-01T00:00:00Z',
        span_end_time_unix_nano_epoch: 0,
        span_duration_ns: 0,
      }),
    ]);
    expect(run.status).toBe('incomplete');
    expect(run.durationMs).toBeUndefined();
    expect(run.spans[0].durationMs).toBeUndefined();
  });
  it('preserves sub-millisecond span duration and normalizes timezone-free backend timestamps to UTC', () => {
    const [run] = buildAgentRuns([
      span('a', '', 0, 0, {
        span_start_time_unix_nano: '2026-10-01 00:00:00.000000000',
        span_end_time_unix_nano: '2026-10-01 00:00:00.000500000',
        span_duration_ns: 500000,
      }),
    ]);
    expect(run.startTime).toBe('2026-10-01T00:00:00.000Z');
    expect(run.durationMs).toBe(0.5);
  });
  it('fails the run on a failed child even when the root succeeds', () => {
    const [run] = buildAgentRuns([
      span('root'),
      span('tool', 'root', 100, 100, {
        'gen_ai.tool.name': 'lookup',
        span_status_code: 2,
        span_status_message: 'Timeout',
      }),
    ]);
    expect(run.status).toBe('failed');
    expect(run.spans[1].errors).toEqual(['Timeout']);
  });
  it('preserves captured exception errors even without a status field', () => {
    const [run] = buildAgentRuns([
      span('root', '', 0, 100, {
        span_status_code: undefined,
        event_name: 'exception',
        'event_exception.message': 'Network unreachable',
        'event_exception.type': 'ConnectionError',
        'event_exception.stacktrace': 'stack',
      }),
    ]);
    expect(run.status).toBe('failed');
    expect(run.spans[0].errors).toEqual(['Network unreachable', 'ConnectionError', 'stack']);
  });
  it('retains a failed duplicate row even if another reports success', () => {
    const [run] = buildAgentRuns([span('a', '', 0, 100, { span_status_code: 2 }), span('a')]);
    expect(run.status).toBe('failed');
  });
  it('selects latest duplicate metadata, discloses conflicts, and does not duplicate span conversation', () => {
    const messages = [{ role: 'user', content: 'Hello' }];
    const [run] = buildAgentRuns([
      span('a', '', 0, 200, {
        p_timestamp: '2026-10-01T00:00:02Z',
        ...modelFields,
        'gen_ai.usage.input_tokens': 10,
        'gen_ai.input.messages': messages,
        event_name: 'gen_ai.user.message',
      }),
      span('a', '', 0, 100, {
        p_timestamp: '2026-10-01T00:00:01Z',
        ...modelFields,
        'gen_ai.usage.input_tokens': 5,
        'gen_ai.input.messages': messages,
        event_name: 'gen_ai.assistant.message',
      }),
    ]);
    expect(run.inputTokens).toBe(10);
    expect(run.durationMs).toBe(200);
    expect(run.spans[0].conversation).toHaveLength(1);
    expect(run.status).toBe('incomplete');
    expect(run.warnings).toContain(
      'Conflicting records share a span ID; displayed telemetry may be incomplete.',
    );
  });
  it('captures older GenAI message-event content attributes', () => {
    const [run] = buildAgentRuns([
      span('a', '', 0, 100, {
        event_name: 'gen_ai.user.message',
        event_content: { role: 'user', content: 'Hi' },
      }),
    ]);
    expect(run.spans[0].conversation).toEqual([
      { label: 'gen_ai.user.message · content', value: { role: 'user', content: 'Hi' } },
    ]);
  });
  it('preserves message event roles and nested captured content', () => {
    const [run] = buildAgentRuns([
      span('a', '', 0, 100, {
        event_name: 'gen_ai.assistant.message',
        event_role: 'assistant',
        'event_content.text': 'Hello',
        'event_content.tool_calls': [{ name: 'lookup', arguments: { query: 'hi' } }],
      }),
    ]);
    expect(run.spans[0].conversation.map((entry) => entry.label)).toEqual([
      'gen_ai.assistant.message · role',
      'gen_ai.assistant.message · content.text',
      'gen_ai.assistant.message · content.tool_calls',
    ]);
  });
  it('rejects totals exceeding numeric precision even when each call reports safe tokens', () => {
    const [run] = buildAgentRuns([
      span('a', '', 0, 100, { 'gen_ai.usage.input_tokens': Number.MAX_SAFE_INTEGER }),
      span('b', '', 0, 100, { 'gen_ai.usage.input_tokens': 1 }),
    ]);
    expect(run.inputTokens).toBeUndefined();
    expect(run.warnings).toContain(
      'Token usage exceeds the safe numeric range and cannot be totaled reliably.',
    );
  });
  it('retains orphan spans as roots and marks the sample incomplete', () => {
    const [run] = buildAgentRuns([span('child', 'missing')]);
    expect(run.roots.map((root) => root.name)).toEqual(['child']);
    expect(run.status).toBe('incomplete');
    expect(run.warnings).toContain('A parent span is outside the captured sample or missing.');
  });
  it('cuts parent cycles while preserving every span exactly once', () => {
    const [run] = buildAgentRuns([span('a', 'b'), span('b', 'a'), span('self', 'self')]);
    const visited: string[] = [];
    const visit = (node: (typeof run.spans)[number]) => {
      visited.push(node.name);
      node.children.forEach(visit);
    };
    run.roots.forEach(visit);
    expect(visited.sort()).toEqual(['a', 'b', 'self']);
    expect(run.status).toBe('incomplete');
    expect(run.warnings).toContain('A cycle in span parent IDs was removed from the tree.');
  });
  it('keeps anonymous or zero-ID records separate instead of inventing a shared run', () => {
    const anonymous = {
      'gen_ai.agent.name': 'Same agent',
      span_trace_id: '0000',
      span_span_id: '0000',
    };
    const runs = buildAgentRuns([anonymous, anonymous]);
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.status)).toEqual(['incomplete', 'incomplete']);
    expect(new Set(runs.map((run) => run.id)).size).toBe(2);
  });
  it('groups explicit run IDs when trace IDs are absent and discloses limited grouping', () => {
    const runs = buildAgentRuns([
      span('a', '', 0, 100, { span_trace_id: undefined, 'gen_ai.agent.run.id': 'run-1' }),
      span('b', 'a', 0, 100, { span_trace_id: undefined, 'gen_ai.agent.run.id': 'run-1' }),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].spans).toHaveLength(2);
    expect(runs[0].traceId).toBeUndefined();
    expect(runs[0].status).toBe('incomplete');
  });
  it('discloses the record limit and does not turn a bounded sample into a successful complete run', () => {
    const [run] = buildAgentRuns([span('root')], 'p_timestamp', { limitReached: true });
    expect(run.status).toBe('incomplete');
    expect(run.warnings).toContain(
      'The telemetry record limit was reached; runs may be incomplete.',
    );
  });
  it('preserves structured conversation and tool arguments/results without inventing uncaptured content', () => {
    const [run] = buildAgentRuns([
      span('tool', '', 0, 100, {
        'gen_ai.tool.name': 'search',
        'gen_ai.tool.call.arguments': { query: 'hello' },
        'gen_ai.tool.call.result': ['result'],
        'gen_ai.input.messages': null,
        'gen_ai.output.messages': '',
      }),
    ]);
    expect(run.spans[0].conversation).toEqual([
      { label: 'gen_ai.tool.call.arguments', value: { query: 'hello' } },
      { label: 'gen_ai.tool.call.result', value: ['result'] },
    ]);
    expect(buildAgentRuns([span('a')])[0].spans[0].conversation).toEqual([]);
  });
  it('captures recognized typed content siblings without hiding recorded field names', () => {
    const row = span('tool', '', 0, 100, {
      'gen_ai.tool.name': 'lookup',
      'gen_ai.tool.call.result': 'Canonical result',
      'gen_ai.tool.call.result_utf8': 'Typed result',
      'gen_ai.input.messages_list': ['Question'],
      'gen_ai.output.messages_struct': { content: 'Answer' },
      'input.value_int64': 7,
      'output.value_bool': false,
      'gen_ai.prompt_unrecognized': 'Not a content sibling',
    });
    const [run] = buildAgentRuns([row, { ...row, link_span_id: 'linked' }]);
    expect(run.spans[0].conversation).toEqual([
      { label: 'gen_ai.tool.call.result', value: 'Canonical result' },
      { label: 'gen_ai.tool.call.result_utf8', value: 'Typed result' },
      { label: 'gen_ai.input.messages_list', value: ['Question'] },
      { label: 'gen_ai.output.messages_struct', value: { content: 'Answer' } },
      { label: 'input.value_int64', value: 7 },
      { label: 'output.value_bool', value: false },
    ]);
  });
  it('captures typed GenAI attributes on flattened events', () => {
    const [run] = buildAgentRuns([
      span('model', '', 0, 100, {
        event_name: 'gen_ai.assistant.message',
        'event_gen_ai.output.messages_utf8': '[{"content":"Answer"}]',
        event_content_utf8: 'Answer',
      }),
    ]);
    expect(run.spans[0].conversation).toEqual([
      {
        label: 'gen_ai.assistant.message · gen_ai.output.messages_utf8',
        value: '[{"content":"Answer"}]',
      },
      { label: 'gen_ai.assistant.message · content_utf8', value: 'Answer' },
    ]);
  });
  it('orders conversation by event time while retaining unknown positions and stable ties', () => {
    const event = (value: string, time?: string) =>
      span('model', '', 0, 100, {
        event_name: 'gen_ai.user.message',
        event_time_unix_nano: time,
        event_content: value,
      });
    const [run] = buildAgentRuns([
      event('Answer', '2026-10-01T00:00:02Z'),
      event('Unknown'),
      event('Question', '2026-10-01 00:00:01'),
      event('Same-time followup', '2026-10-01T00:00:01Z'),
      event('Answer', '2026-10-01T00:00:02Z'),
    ]);
    expect(run.spans[0].conversation.map((entry) => entry.value)).toEqual([
      'Question',
      'Unknown',
      'Same-time followup',
      'Answer',
    ]);
  });
  it('orders sub-millisecond event times and retains distinct repeated messages', () => {
    const event = (time: string) =>
      span('model', '', 0, 100, {
        event_name: 'gen_ai.user.message',
        event_time_unix_nano: time,
        event_content: 'Repeat',
      });
    const [run] = buildAgentRuns([
      { ...event('2026-10-01 00:00:00.000000002'), event_role: 'second' },
      { ...event('2026-10-01T00:00:00.000000001Z'), event_role: 'first' },
      { ...event(String(BigInt(started) * 1_000_000n + 3n)), event_role: 'third' },
    ]);
    expect(
      run.spans[0].conversation
        .filter((entry) => entry.label.endsWith('role'))
        .map((entry) => entry.value),
    ).toEqual(['first', 'second', 'third']);
    expect(run.spans[0].conversation.filter((entry) => entry.value === 'Repeat')).toHaveLength(3);
  });
  it('prefers epochs over backend millisecond text for event order and deduplication', () => {
    const epoch = BigInt(started) * 1_000_000n;
    const event = (role: string, recordedEpoch: number | string) =>
      span('model', '', 0, 100, {
        event_name: 'gen_ai.user.message',
        // Arrow's millisecond timestamp column renders both events identically.
        event_time_unix_nano: '2026-10-01 00:00:00.000',
        event_time_unix_nano_epoch: recordedEpoch,
        event_content: 'Repeat',
        event_role: role,
      });
    const later = event('second', Number(epoch + 200_000n));
    const [run] = buildAgentRuns([
      later,
      event('first', String(epoch + 100_000n)),
      { ...later, link_span_id: 'linked' },
    ]);
    expect(
      run.spans[0].conversation
        .filter((entry) => entry.label.endsWith('role'))
        .map((entry) => entry.value),
    ).toEqual(['first', 'second']);
    expect(run.spans[0].conversation.filter((entry) => entry.value === 'Repeat')).toHaveLength(2);
  });
  it('keeps missing and invalid epoch events in place without trusting their timestamp text', () => {
    const epoch = BigInt(started) * 1_000_000n;
    const event = (content: string, recordedEpoch?: unknown) =>
      span('model', '', 0, 100, {
        event_name: 'gen_ai.user.message',
        event_time_unix_nano: '2026-10-01 00:00:00.000',
        event_time_unix_nano_epoch: recordedEpoch,
        event_content: content,
      });
    for (const invalid of [0, '0', -1, NaN, 1.5, 'invalid', true, null]) {
      const [run] = buildAgentRuns([
        event('Later', String(epoch + 200_000n)),
        event('Unknown', invalid),
        event('Earlier', Number(epoch + 100_000n)),
      ]);
      expect(run.spans[0].conversation.map((entry) => entry.value)).toEqual([
        'Earlier',
        'Unknown',
        'Later',
      ]);
    }
    const [run] = buildAgentRuns([
      event('Later', String(epoch + 200_000n)),
      { ...event('Missing'), event_time_unix_nano: undefined },
      event('Earlier', Number(epoch + 100_000n)),
    ]);
    expect(run.spans[0].conversation.map((entry) => entry.value)).toEqual([
      'Earlier',
      'Missing',
      'Later',
    ]);
  });
  it('includes independent connected agent branches without counting their ancestor rollups', () => {
    const [run] = buildAgentRuns([
      span('root', '', 0, 1000, {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.usage.input_tokens': 5100,
        'gen_ai.usage.output_tokens': 910,
      }),
      span('chat', 'root', 10, 100, {
        ...modelFields,
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 10,
      }),
      span('opaque', 'root', 200, 100, {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.usage.input_tokens': 5000,
        'gen_ai.usage.output_tokens': 900,
      }),
    ]);
    expect(run.inputTokens).toBe(5100);
    expect(run.outputTokens).toBe(910);
    expect(run.warnings).toEqual([]);
  });
  it('selects independent usage per direction and the deepest rollup in a branch', () => {
    const [run] = buildAgentRuns([
      span('root', '', 0, 1000, { 'gen_ai.operation.name': 'invoke_agent' }),
      span('chat', 'root', 10, 100, {
        ...modelFields,
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 10,
      }),
      span('opaque', 'root', 200, 300, {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.usage.input_tokens': 5000,
        'gen_ai.usage.output_tokens': 900,
      }),
      span('tool', 'opaque', 250, 100, {
        'gen_ai.tool.name': 'lookup',
        'gen_ai.usage.input_tokens': 5000,
      }),
    ]);
    expect(run.inputTokens).toBe(5100);
    expect(run.outputTokens).toBe(910);
  });
  it('discloses excluded disconnected rollups while preserving model-call precedence', () => {
    const [run] = buildAgentRuns([
      span('root', '', 0, 1000, {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.usage.input_tokens': 100,
      }),
      span('chat', 'missing', 10, 100, { ...modelFields, 'gen_ai.usage.input_tokens': 100 }),
    ]);
    expect(run.inputTokens).toBe(100);
    expect(run.warnings).toContain(
      'Token usage is partial because disconnected rollups may overlap model calls.',
    );
  });
  it('discloses missing model usage even when a connected agent branch reports a rollup', () => {
    const [run] = buildAgentRuns([
      span('root', '', 0, 1000, { 'gen_ai.operation.name': 'invoke_agent' }),
      span('chat', 'root', 10, 100, { ...modelFields, 'gen_ai.usage.input_tokens': 100 }),
      span('opaque', 'root', 200, 300, {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.usage.input_tokens': 5000,
      }),
      span('unreported', 'opaque', 250, 100, modelFields),
    ]);
    expect(run.inputTokens).toBe(5100);
    expect(run.warnings).toContain(
      'Token usage is partial because some model calls do not report usage.',
    );
  });
  it('rejects unsafe totals that include independent agent usage', () => {
    const [run] = buildAgentRuns([
      span('root', '', 0, 1000, { 'gen_ai.operation.name': 'invoke_agent' }),
      span('chat', 'root', 10, 100, {
        ...modelFields,
        'gen_ai.usage.input_tokens': Number.MAX_SAFE_INTEGER,
      }),
      span('opaque', 'root', 200, 100, {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.usage.input_tokens': 1,
      }),
    ]);
    expect(run.inputTokens).toBeUndefined();
    expect(run.warnings).toContain(
      'Token usage exceeds the safe numeric range and cannot be totaled reliably.',
    );
  });
  it('provides realistic successful, failed, and incomplete demo runs', () => {
    const runs = buildAgentRuns(agentDemoRows(started));
    expect(runs.map((run) => run.status)).toEqual(['success', 'failed', 'incomplete']);
    expect(runs[0].spans).toHaveLength(4);
    expect(runs[0].inputTokens).toBe(240);
    expect(runs[0].durationMs).toBe(1500);
    expect(runs[2].durationMs).toBeUndefined();
  });
});
