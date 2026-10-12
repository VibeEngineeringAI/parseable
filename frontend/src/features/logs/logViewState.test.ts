import { describe, expect, it } from 'vitest';
import { decodeLogView, encodeLogView, type LogViewState } from './logViewState';

const state: LogViewState = {
  version: 1,
  dataset: 'app/logs',
  range: { startTime: '2026-10-12T10:00:00Z', endTime: '2026-10-12T11:00:00Z' },
  search: 'errors & warnings',
  expression: {
    combinator: 'and',
    groups: [
      {
        id: 'g1',
        combinator: 'or',
        rules: [
          { id: 'r1', field: 'message', operator: '=', value: "a' OR true --" },
          { id: 'r2', field: 'level', operator: '!=', value: 'info' },
        ],
      },
    ],
  },
  columns: ['p_timestamp', 'message'],
  timezone: 'America/Chicago',
  limit: 5000,
  wrap: true,
  showHistogram: false,
};
describe('log view state', () => {
  it('round trips complete state through URLSearchParams without losing escaped values', () => {
    const params = new URLSearchParams({ view: encodeLogView(state) });
    expect(decodeLogView(new URLSearchParams(params.toString()).get('view')!)).toEqual(state);
  });
  it('supports relative saved ranges and omitted columns', () => {
    const { columns: _columns, ...rest } = state;
    expect(decodeLogView(encodeLogView({ ...rest, range: '1h' }))).toEqual({
      ...rest,
      range: '1h',
    });
  });
  it.each([
    [{ version: 2 }, 'version'],
    [{ timezone: 'Mars/Olympus' }, 'timezone'],
    [{ timezone: '+05:30' }, 'timezone'],
    [{ timezone: 'local' }, 'timezone'],
    [{ limit: 10001 }, 'limit'],
    [{ limit: 1.5 }, 'limit'],
    [{ wrap: 'true' }, 'display'],
    [{ range: { startTime: '2026-10-12T11:00:00Z', endTime: '2026-10-12T10:00:00Z' } }, 'bounds'],
    [{ range: { startTime: '2026-10-12T10:00:00', endTime: '2026-10-12T11:00:00' } }, 'bounds'],
    [{ expression: { combinator: 'xor', groups: [] } }, 'combinator'],
    [
      {
        expression: {
          combinator: 'and',
          groups: [
            {
              id: 'g',
              combinator: 'and',
              rules: [{ id: 'r', field: 'message', operator: 'LIKE', value: '%' }],
            },
          ],
        },
      },
      'operator',
    ],
    [{ columns: [42] }, 'column'],
  ])('rejects unsupported or malformed state %j', (patch, message) => {
    expect(() => decodeLogView(JSON.stringify({ ...state, ...patch }))).toThrow(message);
  });
  it('rejects huge links and malformed JSON', () => {
    expect(() => decodeLogView('x'.repeat(65537))).toThrow('too large');
    expect(() => decodeLogView('{')).toThrow('malformed JSON');
  });
  it('rejects calendar dates that Date.parse silently normalizes', () => {
    expect(() =>
      encodeLogView({
        ...state,
        range: { startTime: '2026-02-31T10:00:00Z', endTime: '2026-03-10T10:00:00Z' },
      }),
    ).toThrow('bounds');
  });
  it('bounds filter groups and rules', () => {
    expect(() =>
      encodeLogView({
        ...state,
        expression: {
          combinator: 'and',
          groups: Array.from({ length: 13 }, (_, i) => ({
            id: String(i),
            combinator: 'and',
            rules: [],
          })),
        },
      }),
    ).toThrow('groups');
    expect(() =>
      encodeLogView({
        ...state,
        expression: {
          combinator: 'and',
          groups: [
            {
              id: 'g',
              combinator: 'and',
              rules: Array.from({ length: 51 }, (_, i) => ({
                id: String(i),
                field: 'message',
                operator: '=',
                value: '',
              })),
            },
          ],
        },
      }),
    ).toThrow('too many');
  });
  it('rejects NUL characters and duplicate identifiers before queries or edits', () => {
    expect(() => encodeLogView({ ...state, dataset: 'app\0' })).toThrow('dataset');
    expect(() => encodeLogView({ ...state, search: 'error\0' })).toThrow('search');
    const group = state.expression.groups[0];
    expect(() =>
      encodeLogView({ ...state, expression: { combinator: 'and', groups: [group, group] } }),
    ).toThrow('duplicate group');
    expect(() =>
      encodeLogView({
        ...state,
        expression: {
          combinator: 'and',
          groups: [{ ...group, rules: [group.rules[0], group.rules[0]] }],
        },
      }),
    ).toThrow('duplicate rule');
  });
  it('discards unrecognized metadata instead of round tripping executable input', () => {
    const result = decodeLogView(
      JSON.stringify({ ...state, query: 'DROP TABLE logs', credentials: 'private' }),
    );
    expect(result).toEqual(state);
  });
});
