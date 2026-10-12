import { describe, expect, it, vi } from 'vitest';
import {
  agentsPath,
  agentRangeFromParams,
  agentBoundsFromParams,
  agentText,
  buildAgentQuery,
  discoverAgentDatasets,
  isAgentSchema,
} from './agents';
import { createDemoClient } from './demo';
import { ApiError } from './apiError';
const bounds = { startTime: '2026-10-01T00:00:00Z', endTime: '2026-10-02T00:00:00Z' };
describe('agent telemetry contract', () => {
  it('preserves preset refresh semantics and captured handoff bounds', () => {
    const params = new URLSearchParams({
      range: '24h',
      start: bounds.startTime,
      end: bounds.endTime,
    });
    expect(agentRangeFromParams(params)).toBe('24h');
    expect(agentBoundsFromParams(params)).toEqual({
      startTime: '2026-10-01T00:00:00.000Z',
      endTime: '2026-10-02T00:00:00.000Z',
    });
    const preset = agentBoundsFromParams(new URLSearchParams({ range: '7d' }));
    expect(Date.parse(preset.endTime) - Date.parse(preset.startTime)).toBe(7 * 86400000);
  });
  it('only discovers recognized agent fields, and encodes dataset paths', () => {
    expect(isAgentSchema(['http.user_agent', 'span_name'])).toBe(false);
    expect(isAgentSchema(['gen_ai.tool.name'])).toBe(true);
    expect(agentsPath('a/b?c')).toBe('/agents/a%2Fb%3Fc');
  });
  it('quotes dataset and custom time fields, excludes absent columns, and bounds records', () => {
    const query = buildAgentQuery(
      'a"b',
      ['gen_ai.request.model', 'event"time'],
      bounds,
      'event"time',
    );
    expect(query.sql).toBe(
      'SELECT * FROM "a""b" WHERE "gen_ai.request.model" IS NOT NULL ORDER BY "event""time" DESC LIMIT 100',
    );
    expect(query.startTime).toBe('2026-10-01T00:00:00.000Z');
    expect(query.sql).not.toContain('gen_ai.agent.name');
  });
  it('rejects unsupported schemas and invalid time bounds before executing SQL', () => {
    expect(() => buildAgentQuery('x', ['p_timestamp'], bounds)).toThrow('no recognized');
    expect(() => buildAgentQuery('x', ['gen_ai.tool.name'], bounds)).toThrow('missing the time');
    expect(() =>
      buildAgentQuery('x', ['gen_ai.tool.name', 'p_timestamp'], {
        ...bounds,
        endTime: bounds.startTime,
      }),
    ).toThrow('Invalid time');
  });
  it('skips restricted discovery entries and propagates session expiry', async () => {
    const client = {
      ...createDemoClient(),
      listDatasets: async () => [
        { name: 'allowed', type: 'logs' as const },
        { name: 'denied', type: 'logs' as const },
      ],
      schema: vi.fn(async (name: string) => {
        if (name === 'denied') throw new ApiError('Denied', 403);
        return ['gen_ai.request.model'];
      }),
    };
    const result = await discoverAgentDatasets(client);
    expect(result.datasets.map((entry) => entry.name)).toEqual(['allowed']);
    expect(result.unchecked).toEqual([]);
    client.schema.mockRejectedValueOnce(new ApiError('Expired', 401));
    await expect(discoverAgentDatasets(client)).rejects.toMatchObject({ status: 401 });
  });
  it('skips datasets removed during discovery but reports operational failures', async () => {
    const client = {
      ...createDemoClient(),
      listDatasets: async () => [
        { name: 'removed', type: 'logs' as const },
        { name: 'unavailable', type: 'logs' as const },
      ],
      schema: async (name: string): Promise<string[]> => {
        throw new ApiError(
          name === 'removed' ? 'Not found' : 'Unavailable',
          name === 'removed' ? 404 : 503,
        );
      },
    };
    const result = await discoverAgentDatasets(client);
    expect(result.datasets).toEqual([]);
    expect(result.unchecked).toEqual([
      { name: 'unavailable', compatible: false, error: 'Unavailable' },
    ]);
  });
  it('does not stringify malformed names', () => {
    expect(agentText({ first: {}, second: 'Agent' }, 'first', 'second')).toBe('Agent');
  });
});
