import { describe, expect, it } from 'vitest';
import { agentValueMatchesSearch } from './agentSearch';

describe('agent value search', () => {
  it('matches literal paths and quoted text inside nested captured values', () => {
    const row = {
      arguments: { path: 'C:\\repo', messages: [{ content: 'Say "hello"' }] },
    };
    expect(agentValueMatchesSearch(row, 'C:\\repo')).toBe(true);
    expect(agentValueMatchesSearch(row, 'say "HELLO"')).toBe(true);
    expect(agentValueMatchesSearch(row, 'C:\\\\repo')).toBe(false);
    expect(agentValueMatchesSearch(row, 'messages')).toBe(false);
    expect(agentValueMatchesSearch(row, 'arguments')).toBe(false);
  });

  it('searches scalar values without inventing text for absent telemetry', () => {
    const row = { inputTokens: 240, captured: false, missing: null, absent: undefined };
    expect(agentValueMatchesSearch(row, '240')).toBe(true);
    expect(agentValueMatchesSearch(row, 'false')).toBe(true);
    expect(agentValueMatchesSearch(row, 'null')).toBe(false);
    expect(agentValueMatchesSearch(row, 'undefined')).toBe(false);
    expect(agentValueMatchesSearch(row, 'inputTokens')).toBe(false);
    expect(agentValueMatchesSearch(row, '')).toBe(true);
  });
});
