# Native PromQL threshold alerts

Parseable PromQL threshold alerts evaluate one instant-vector expression against
one metrics dataset. The selected threshold is applied to every returned series,
so labels keep hosts or other dimensions as independent alert instances. This is
the first native threshold-alert contract; it does not load Prometheus rule
files or provide full Prometheus alerting-rule compatibility.

Create the rule with a concrete dataset name, an instant-vector selector, a
threshold, an evaluation schedule, and a hold duration. For example, a rule for
high five-minute host load can use:

```promql
{__name__="system.cpu.load_average.5m"}
```

Set the condition to greater than `8`, choose an evaluation interval of one
minute, and set the hold duration to `5m`. The value `8` is illustrative and
should be tuned to the host's CPU capacity and normal load. The metric's `.5m`
window, its one-minute evaluation interval, and the five-minute hold duration
are separate settings.

The initial API request follows the existing alert shape, with a PromQL query
type, one explicit dataset and `promqlConfig.holdDuration`:

```json
{
  "title": "High host load",
  "query": "{__name__=\"system.cpu.load_average.5m\"}",
  "queryType": "promql",
  "datasets": ["metrics"],
  "alertType": "threshold",
  "thresholdConfig": {"operator": ">", "value": 8},
  "promqlConfig": {"holdDuration": "5m"},
  "evalConfig": {
    "rollingWindow": {
      "evalStart": "10m",
      "evalEnd": "now",
      "evalFrequency": 1
    }
  },
  "notificationConfig": {"interval": 1},
  "targets": []
}
```

The scheduler treats each distinct label set as one instance. An over-threshold
instance is pending until its value stays over threshold for the hold duration,
then becomes firing. A later below-threshold sample resolves that series. Other
series continue their own timers and states.

An empty result reports `noData`; it is not treated as a zero value. Evaluation
errors report `error`. Neither state advances pending time or produces a false
recovery for an already firing instance. After a data gap, pending duration must
be established again from continuous observations. The alert detail response
exposes `promqlRuntime` with evaluation health and per-label instance state.

## Operational behavior

Firing and recovery notifications are sent for state transitions. For Slack and
webhook targets, an ongoing firing instance does not generate recurring repeat
messages. A failed delivery
is retained in `promqlRuntime.deliveries` with its attempt count and error, then
retried on later alert evaluations for up to three attempts. Each evaluation
makes at most one attempt for a queued delivery. After the third failure, the
exhausted delivery remains visible for inspection; it is not sent repeatedly.
Only the 50 most recent exhausted deliveries are kept.

The outbox never blocks state evaluation. It holds at most 1000 queued
deliveries. If a burst of transitions exceeds that, the oldest queued
deliveries are dropped and a warning is logged.

Alertmanager targets receive each instance as its own alert. Its labels are the
series labels (without `__name__`), `alertname` set to the rule title, and the
`deployment_instance`, `deployment_id` and `deployment_mode` labels. Grouping,
inhibition and routing can therefore match series labels such as `host` or
`job`. Every evaluation re-sends all firing instances to Alertmanager targets,
as Prometheus does, with `endsAt` four evaluation intervals ahead. Alertmanager
deduplicates these by label set, so they do not cause repeat notifications.
A firing alert therefore stays active in Alertmanager while Parseable still
reports it as firing. If re-sends stop, for example because the rule is muted,
disabled or edited, or its owner loses access, Alertmanager resolves the alert
once `endsAt` passes. A failed re-send is logged and retried at the next
evaluation.

Editing a rule resets its instance state and pending timers because its query,
dataset, threshold, or hold duration may have changed. Disabling a rule clears
its runtime; enabling it starts new pending intervals. A firing state is
preserved across a server restart, while a pending interval restarts from zero
because continuity could not be established.

Scheduled PromQL evaluations capture the creating user's stable identity and
recheck that user's current `Query` permission for the selected dataset on each
run. Revoking access or deleting the owner makes evaluation health report an
error; a firing instance is retained and notifications pause until authorization
is restored. Editing the rule records the editing user as its new owner.

PromQL threshold alerts are available in `All` and `Query` deployment modes.
Their scheduler and persisted evaluation state are designed for a single Parseable
server. Distributed scheduler ownership is outside this first version.

## End-to-end check

With a running server that has PromQL alerts enabled, run:

```sh
python3 scripts/test-promql-alerts.py
```

The script creates a uniquely named OTLP dataset and alert, then checks an early
breach, recovery, sustained firing, independent state for two series, empty
results, and dataset authorization. It also creates a scoped writer-owned rule,
revokes that user's `Query` permission after the rule fires, and checks that
scheduled evaluation reports an error while retaining the firing instance. It
removes its alerts, users, roles and datasets in a `finally` cleanup path. Set
`P_ADDR`, `PARSEABLE_URL`, `P_USERNAME`, `P_PASSWORD`,
`PARSEABLE_API_PREFIX` or `PROMQL_ALERTS_WAIT_SECONDS` to match the local server.

The live smoke passed against the feature build with:

```sh
python3 scripts/test-promql-alerts.py --allow-local-webhook-policy
```

It verified per-series pending, firing and recovery; empty-vector No Data;
scoped-owner permission revocation with firing-state retention; and cleanup of
its temporary rules, users, roles and datasets. The loopback receiver returned a
controlled HTTP 503: the script observed the persisted failed attempt, retried on
the next manual evaluation, and confirmed a successful response cleared the
delivery queue. It also confirmed that the revoked owner produced no additional
webhook delivery.

To verify firing delivery, the script can create a loopback webhook. The server's
outbound policy blocks private destinations by default, so this option saves the
current tenant policy, temporarily permits only `127.0.0.1/32`, then restores the
saved policy:

```sh
python3 scripts/test-promql-alerts.py --allow-local-webhook-policy
```

This check sends only to its own local receiver. Do not point it at an external
webhook. The script will report cleanup failures, including policy restoration
failures, rather than treating an incomplete cleanup as success. It also checks
that revoking the firing rule owner's dataset permission does not produce a
duplicate webhook delivery. The receiver returns one HTTP 503 so the script can
check the persisted attempt and error, then retry successfully and confirm the
delivery queue clears.
