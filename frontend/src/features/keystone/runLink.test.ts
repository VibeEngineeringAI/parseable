import { describe, expect, it } from 'vitest';
import { isPlainClick, readRunLink, runHref, writeRunLink } from './runLink';

describe('run links', () => {
  it('reads node and run, treating empty values as absent', () => {
    expect(readRunLink(new URLSearchParams('node=n1&run=r1'))).toEqual({
      nodeId: 'n1',
      runId: 'r1',
    });
    expect(readRunLink(new URLSearchParams('node=&run='))).toEqual({ nodeId: null, runId: null });
  });

  it('writes the target and keeps unrelated parameters', () => {
    const next = writeRunLink(new URLSearchParams('tab=x&run=old'), { nodeId: 'n', runId: null });
    expect(next.toString()).toBe('tab=x&node=n');
  });

  it('never writes a run without its question', () => {
    expect(writeRunLink(new URLSearchParams(), { nodeId: null, runId: 'r' }).toString()).toBe('');
  });

  it('encodes identifiers into a shareable href', () => {
    expect(runHref('/app/keystone/i%201', { nodeId: 'a b', runId: 'r&1' })).toBe(
      '/app/keystone/i%201?node=a+b&run=r%261',
    );
    expect(runHref('/keystone/i', { nodeId: null, runId: null })).toBe('/keystone/i');
  });

  it('handles only plain primary clicks in place', () => {
    const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(isPlainClick(click)).toBe(true);
    expect(isPlainClick({ ...click, metaKey: true })).toBe(false);
    expect(isPlainClick({ ...click, button: 1 })).toBe(false);
  });
});
