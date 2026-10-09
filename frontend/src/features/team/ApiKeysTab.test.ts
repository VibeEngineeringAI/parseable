import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiKey } from '../../lib/types';
import { copyApiKey } from './ApiKeysTab';

afterEach(() => vi.unstubAllGlobals());

const key: ApiKey = {
  keyId: 'key-id',
  keyName: 'automation',
  apiKey: 'full-test-key',
  roles: ['analysts'],
  createdBy: 'admin',
  createdAt: '2026-10-08T12:00:00Z',
  modifiedAt: '2026-10-08T12:00:00Z',
};

class TestClipboardItem {
  constructor(readonly data: Record<string, Promise<Blob>>) {}
}

describe('API key clipboard', () => {
  it('starts writing synchronously before the key fetch resolves', async () => {
    vi.stubGlobal('ClipboardItem', TestClipboardItem);
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { write } });
    let resolveKey!: (value: ApiKey) => void;
    const fetching = new Promise<ApiKey>((resolve) => {
      resolveKey = resolve;
    });

    const copying = copyApiKey(fetching, { current: true });
    expect(write).toHaveBeenCalledTimes(1);
    const [item] = write.mock.calls[0][0] as TestClipboardItem[];
    resolveKey(key);
    const blob = await item.data['text/plain'];
    expect(blob.type).toBe('text/plain');
    expect(await blob.text()).toBe(key.apiKey);
    await copying;
  });

  it('falls back to writeText when ClipboardItem is unavailable', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await copyApiKey(Promise.resolve(key), { current: true });
    expect(writeText).toHaveBeenCalledWith(key.apiKey);
  });

  it.each([true, false])(
    'shows a clear clipboard failure (ClipboardItem: %s)',
    async (available) => {
      vi.stubGlobal('ClipboardItem', available ? TestClipboardItem : undefined);
      const failure = new DOMException('The request is not allowed.', 'NotAllowedError');
      const write = vi.fn().mockRejectedValue(failure);
      vi.stubGlobal('navigator', { clipboard: { write, writeText: write } });

      await expect(copyApiKey(Promise.resolve(key), { current: true })).rejects.toThrow(
        'Unable to copy API key. Check your browser clipboard permissions and try again.',
      );
    },
  );

  it.each([true, false])(
    'preserves the original key-fetch error (ClipboardItem: %s)',
    async (available) => {
      vi.stubGlobal('ClipboardItem', available ? TestClipboardItem : undefined);
      const failure = new Error('Permission denied');
      const write = vi.fn(async ([item]: TestClipboardItem[]) => {
        await item.data['text/plain'].catch(() => {
          throw new DOMException('Could not read clipboard data.', 'NotAllowedError');
        });
      });
      const writeText = vi.fn();
      vi.stubGlobal('navigator', { clipboard: { write, writeText } });

      await expect(copyApiKey(Promise.reject(failure), { current: true })).rejects.toBe(failure);
      expect(writeText).not.toHaveBeenCalled();
    },
  );

  it('does not write the fetched key after unmount in the fallback path', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const active = { current: true };
    const copying = copyApiKey(Promise.resolve(key), active);
    active.current = false;

    await copying;
    expect(writeText).not.toHaveBeenCalled();
  });
});
