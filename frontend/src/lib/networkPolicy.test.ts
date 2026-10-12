import { describe, it, expect, vi } from 'vitest';
import {
  decodeAlertTargetPolicy,
  emptyAlertTargetPolicy,
  policyLines,
  invalidPolicyDomain,
} from './networkPolicy';
import { createDemoClient } from './demo';
import { createClient } from './client';
describe('outbound alert policy contract', () => {
  it('requires every field and rejects HTML or malformed arrays', () => {
    const policy = emptyAlertTargetPolicy();
    expect(decodeAlertTargetPolicy(policy)).toEqual(policy);
    for (const key of Object.keys(policy)) {
      const bad = { ...policy } as Record<string, unknown>;
      delete bad[key];
      expect(() => decodeAlertTargetPolicy(bad)).toThrow();
    }
    expect(() => decodeAlertTargetPolicy('<html>')).toThrow();
    expect(() => decodeAlertTargetPolicy({ ...policy, allowedCidrs: [3] })).toThrow();
  });
  it('splits line entries without treating commas as separators', () => {
    expect(policyLines(' a.example \r\n\n b.example\n')).toEqual(['a.example', 'b.example']);
    expect(policyLines('a,b')).toEqual(['a,b']);
  });
  it('keeps demo writes isolated per client and copies outputs', async () => {
    const first = createDemoClient(),
      second = createDemoClient();
    const policy = { ...emptyAlertTargetPolicy(), allowedDomains: ['alerts.example'] };
    await first.putAlertTargetPolicy(policy);
    policy.allowedDomains.push('mutated.example');
    expect((await first.getAlertTargetPolicy()).allowedDomains).toEqual(['alerts.example']);
    expect(await second.getAlertTargetPolicy()).toEqual(emptyAlertTargetPolicy());
  });
  it('reads and writes exactly the full verified endpoint contract', async () => {
    const policy = {
      ...emptyAlertTargetPolicy(),
      allowPrivate: true,
      allowedCidrs: ['10.0.0.0/8'],
    };
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(policy)));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = createClient({ mode: 'live' });
      expect(await client.getAlertTargetPolicy()).toEqual(policy);
      expect(await client.putAlertTargetPolicy(policy)).toEqual(policy);
      expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/alert-target-policy');
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(policy);
      expect(fetchMock.mock.calls[1][1].credentials).toBe('include');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('literal policy domains', () => {
  it('accepts hostnames and rejects URL, glob, path and invalid labels', () => {
    for (const domain of [
      'host',
      'Sub.Example.COM.',
      'xn--example-9za.com',
      'a_b.internal',
      '203.0.113.5',
    ])
      expect(invalidPolicyDomain(domain)).toBeUndefined();
    for (const domain of [
      '*.evil.example',
      'https://host',
      'host:443/path',
      'host name',
      'host\\name',
      '.example',
      'bad..example',
      '-bad.example',
      '127.1',
      '2130706433',
      '0x7f000001',
      '01.2.3.4',
    ])
      expect(invalidPolicyDomain(domain)).toBe(domain);
  });
});
