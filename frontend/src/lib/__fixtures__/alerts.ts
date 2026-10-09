import type { Alert, AlertRequest, AlertSummary, AlertTarget } from '../types';

export const alertRequest: AlertRequest = {
  title: 'Host load',
  severity: 'high',
  query: 'up',
  queryType: 'promql',
  datasets: ['metrics'],
  alertType: 'threshold',
  thresholdConfig: { operator: '>', value: 2.5 },
  promqlConfig: { holdDuration: '5m' },
  evalConfig: { rollingWindow: { evalStart: '10m', evalEnd: 'now', evalFrequency: 1 } },
  notificationConfig: { interval: 1 },
  targets: [],
  tags: ['production'],
};
export const alertFixture: Alert = {
  ...alertRequest,
  id: '01M4H000000000000000000010',
  version: 'v2',
  state: 'not-triggered',
  notificationState: 'notify',
  created: '2026-10-09T12:00:00Z',
  lastTriggeredAt: null,
  promqlRuntime: {
    health: 'ok',
    error: null,
    lastEvaluatedAt: '2026-10-09T12:00:00Z',
    instances: {
      a: {
        labels: { host: 'node-a' },
        state: 'pending',
        pendingSince: '2026-10-09T12:00:00Z',
        lastSeen: '2026-10-09T12:00:00Z',
        value: 3.25,
      },
    },
    deliveries: [
      {
        labels: { host: 'node-a' },
        value: 3.25,
        firing: true,
        target: 'target',
        attempts: 3,
        error: 'failed https://example.com/secret-token',
      },
    ],
  },
};
export const alertSummaryFixture: AlertSummary = {
  id: alertFixture.id,
  title: alertFixture.title,
  severity: 'high',
  state: 'not-triggered',
  alertType: 'threshold',
  datasets: ['metrics'],
  notificationState: 'notify',
  created: '2026-10-09 12:00:00 UTC',
  tags: ['production'],
};
export const targetFixture: AlertTarget = {
  id: '01M4H000000000000000000001',
  name: 'Operations',
  type: 'webhook',
  endpoint: 'https://********',
  headers: { 'X-Source': '********' },
  skipTlsCheck: false,
};
