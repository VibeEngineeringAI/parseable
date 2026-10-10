import { describe, expect, it } from 'vitest';
import {
  alert,
  alertSummary,
  alertTarget,
  alertTargetStatus,
  notificationState,
  promqlRuntime,
} from './alertsContract';
import { alertFixture, alertSummaryFixture, targetFixture } from './__fixtures__/alerts';

describe('alerts response contracts', () => {
  it('accepts full configs, capitalized summaries, chrono dates and flattened runtime', () => {
    expect(alert(alertFixture)).toBe(true);
    expect(
      alertSummary({
        ...alertSummaryFixture,
        severity: 'High',
        promqlRuntime: alertFixture.promqlRuntime,
      }),
    ).toBe(true);
    expect(
      alertSummary({
        ...alertSummaryFixture,
        notificationState: '+262142-12-31T23:59:59.999999999+00:00',
      }),
    ).toBe(true);
    expect(alert({ ...alertFixture, notificationState: { mute: 'indefinite' } })).toBe(true);
  });
  it('lists unsupported alert types but only accepts threshold configs', () => {
    expect(alertSummary({ ...alertSummaryFixture, alertType: 'anomaly' })).toBe(true);
    expect(alert({ ...alertFixture, alertType: 'anomaly' })).toBe(false);
  });
  it.each([
    null,
    [],
    {},
    { ...alertFixture, queryType: 'sql' },
    { ...alertFixture, severity: 'High' },
    { ...alertFixture, thresholdConfig: { operator: '==', value: 1 } },
    { ...alertFixture, thresholdConfig: { operator: '>', value: Infinity } },
    { ...alertFixture, targets: [1] },
    {
      ...alertFixture,
      evalConfig: { rollingWindow: { evalStart: '10m', evalEnd: 'now', evalFrequency: 0 } },
    },
    { ...alertFixture, promqlConfig: { holdDuration: 5 } },
    { ...alertFixture, notificationState: { mute: false } },
    { ...alertFixture, tags: [false] },
    { ...alertFixture, executionIdentity: { userId: 1 } },
  ])('rejects malformed alert %#', (value) => expect(alert(value)).toBe(false));
  it.each([
    { ...alertSummaryFixture, state: 'firing' },
    { ...alertSummaryFixture, severity: 'urgent' },
    { ...alertSummaryFixture, datasets: {} },
    { ...alertSummaryFixture, queryType: 'sql' },
    { ...alertSummaryFixture, alertType: '' },
    { ...alertSummaryFixture, alertType: undefined },
  ])('rejects malformed summary %#', (value) => expect(alertSummary(value)).toBe(false));
  it.each(['notify', 'indefinite', { mute: '2026-10-10T00:00:00Z' }])(
    'accepts notification state %j',
    (value) => expect(notificationState(value)).toBe(true),
  );
  it('validates every runtime leaf', () => {
    const runtime = alertFixture.promqlRuntime!;
    expect(promqlRuntime(runtime)).toBe(true);
    for (const invalid of [
      { ...runtime, health: 'unknown' },
      { ...runtime, instances: { a: { ...runtime.instances.a, value: '3.25' } } },
      { ...runtime, instances: { a: { ...runtime.instances.a, state: 'triggered' } } },
      { ...runtime, deliveries: [{ ...runtime.deliveries[0], attempts: '3' }] },
      { ...runtime, deliveries: [{ ...runtime.deliveries[0], labels: { a: 1 } }] },
    ])
      expect(promqlRuntime(invalid)).toBe(false);
  });
  it('validates wrapped and bare masked targets, including Alertmanager as webhook', () => {
    expect(alertTarget(targetFixture)).toBe(true);
    expect(
      alertTarget({ ...targetFixture, headers: undefined, username: null, password: null }),
    ).toBe(true);
    expect(
      alertTargetStatus({
        target: targetFixture,
        enabled: false,
        error: 'Policy blocks private addresses',
      }),
    ).toBe(true);
    expect(alertTargetStatus(targetFixture)).toBe(false);
    expect(alertTargetStatus({ target: targetFixture, enabled: 'true' })).toBe(false);
    expect(alertTarget({ ...targetFixture, headers: { token: 123 } })).toBe(false);
    expect(alertTarget({ ...targetFixture, skipTlsCheck: 'true' })).toBe(false);
  });
});
