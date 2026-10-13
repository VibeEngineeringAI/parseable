import { describe, expect, it } from 'vitest';
import {
  captureObservability,
  observabilityBounds,
  observabilityHref,
  observabilityRange,
} from './observabilityNavigation';
import { encodeLogView, decodeLogView } from '../features/logs/logViewState';
import { initialLogView } from '../features/logs/logViewReducer';

const bounds = { startTime: '2026-10-12T09:00:00.000Z', endTime: '2026-10-12T10:00:00.000Z' };
function destination(href: string) {
  return new URL(href, 'https://parseable.test');
}

describe('observability navigation', () => {
  it('restores each view filters independently while carrying exact bounds and preset semantics', () => {
    const agents = captureObservability(
      new URLSearchParams({
        search: 'research',
        status: 'incomplete',
        model: 'm1',
        run: 'r1',
        setup: '1',
      }),
      { view: 'agents', dataset: 'agent spans', range: '1h', bounds },
    );
    const tracesUrl = destination(
      observabilityHref({ pathname: '/agents/agent%20spans', search: agents.toString() }, 'traces'),
    );
    expect(tracesUrl.pathname).toBe('/traces/explore/agent%20spans');
    expect(tracesUrl.searchParams.has('status')).toBe(false);
    expect(tracesUrl.searchParams.has('model')).toBe(false);
    tracesUrl.searchParams.set('service', 'worker');
    tracesUrl.searchParams.set('status', 'error');
    tracesUrl.searchParams.set('sort', 'longestFirst');
    const traces = captureObservability(tracesUrl.searchParams, {
      view: 'traces',
      dataset: 'agent spans',
      range: '1h',
      bounds,
    });
    const logsUrl = destination(
      observabilityHref({ pathname: tracesUrl.pathname, search: traces.toString() }, 'logs'),
    );
    const logView = {
      ...initialLogView('agent spans'),
      search: 'failed',
      expression: {
        combinator: 'or' as const,
        groups: [
          {
            id: 'g',
            combinator: 'and' as const,
            rules: [{ id: 'r', field: 'level', operator: '=' as const, value: 'error' }],
          },
        ],
      },
    };
    const logs = captureObservability(logsUrl.searchParams, {
      view: 'logs',
      dataset: 'agent spans',
      range: '1h',
      bounds,
      query: new URLSearchParams({ logView: encodeLogView(logView) }),
    });
    const backAgents = destination(
      observabilityHref({ pathname: logsUrl.pathname, search: logs.toString() }, 'agents'),
    );
    for (const key of ['search', 'status', 'model', 'run'])
      expect(backAgents.searchParams.get(key)).toBe(agents.get(key));
    expect(agents.get('setup')).toBe('1');
    expect(backAgents.searchParams.has('setup')).toBe(false);
    expect(observabilityRange(backAgents.searchParams)).toBe('1h');
    expect(observabilityBounds(backAgents.searchParams, '1h')).toEqual(bounds);
    const backTraces = destination(
      observabilityHref({ pathname: backAgents.pathname, search: backAgents.search }, 'traces'),
    );
    expect(backTraces.searchParams.get('service')).toBe('worker');
    expect(backTraces.searchParams.get('status')).toBe('error');
    expect(backTraces.searchParams.get('sort')).toBe('longestFirst');
    const backLogs = destination(
      observabilityHref({ pathname: backTraces.pathname, search: backTraces.search }, 'logs'),
    );
    expect(decodeLogView(backLogs.searchParams.get('logView')!)).toEqual(logView);
    expect(backLogs.searchParams.has('service')).toBe(false);
  });

  it('carries trace focus and drops dataset-specific filters when explicitly switching datasets', () => {
    const params = captureObservability(new URLSearchParams({ service: 'old', status: 'error' }), {
      view: 'traces',
      dataset: 'old',
      range: bounds,
      bounds,
    });
    const href = destination(
      observabilityHref({ pathname: '/traces/explore/old', search: params.toString() }, 'traces', {
        dataset: 'new',
        traceId: 'a'.repeat(32),
      }),
    );
    expect(href.pathname).toBe('/traces/explore/new');
    expect(href.searchParams.has('service')).toBe(false);
    expect(href.searchParams.has('status')).toBe(false);
    expect(href.searchParams.get('traceId')).toBe('a'.repeat(32));
    expect(observabilityRange(href.searchParams)).toEqual(bounds);
  });

  it('ignores malformed contexts, malicious destinations and invalid trace IDs', () => {
    for (const observe of [
      '{',
      JSON.stringify({ version: 1, bounds, range: 'unknown', views: {} }),
      JSON.stringify({ version: 1, bounds: {}, range: '1h', views: {} }),
    ]) {
      expect(
        observabilityHref(
          { pathname: '/agents', search: new URLSearchParams({ observe }).toString() },
          'traces',
          { traceId: 'javascript:bad' },
        ),
      ).toBe('/traces');
    }
    const params = captureObservability(new URLSearchParams(), {
      view: 'agents',
      dataset: '//evil.test',
      range: '1h',
      bounds,
    });
    expect(
      destination(observabilityHref({ pathname: '/agents', search: params.toString() }, 'logs'))
        .origin,
    ).toBe('https://parseable.test');
    expect(observabilityRange(new URLSearchParams('range=bogus&start=bad&end=bad'))).toBe('1h');
  });

  it('keeps URL filter edits when leaving before an asynchronous capture completes', () => {
    const source = captureObservability(new URLSearchParams('service=old'), {
      view: 'traces',
      dataset: 'spans',
      range: '1h',
      bounds,
    });
    source.set('service', 'pending-service');
    const agents = destination(
      observabilityHref({ pathname: '/traces/explore/spans', search: source.toString() }, 'agents'),
    );
    const back = destination(
      observabilityHref({ pathname: agents.pathname, search: agents.search }, 'traces'),
    );
    expect(back.searchParams.get('service')).toBe('pending-service');
  });

  it('captures stable native bounds without nesting context or growing on repeat captures', () => {
    const options = { view: 'agents' as const, dataset: 'spans', range: '1h' as const, bounds };
    const first = captureObservability(new URLSearchParams('search=a'), options);
    const second = captureObservability(first, options);
    const third = captureObservability(second, options);
    expect(second.toString()).toBe(third.toString());
    expect(first.get('start')).toBe(bounds.startTime);
    expect(first.get('end')).toBe(bounds.endTime);
    const snapshot = JSON.parse(second.get('observe')!).views.agents.query;
    expect(new URLSearchParams(snapshot).has('observe')).toBe(false);
  });
});
