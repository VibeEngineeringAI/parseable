#!/usr/bin/env python3
"""End-to-end smoke test for native PromQL threshold alerts.

Requires a running Parseable server with PromQL alerts enabled. The optional
local webhook test temporarily changes this user's outbound policy and restores
the exact previous policy in the cleanup path.
"""

import argparse
import base64
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


BASE_URL = os.environ.get("PARSEABLE_URL")
if not BASE_URL:
    addr = os.environ.get("P_ADDR", "127.0.0.1:8000")
    BASE_URL = addr if "://" in addr else f"http://{addr}"
BASE_URL = BASE_URL.rstrip("/")
API_PREFIX = os.environ.get("PARSEABLE_API_PREFIX", "/api/v1").rstrip("/")
USERNAME = os.environ.get("P_USERNAME", "admin")
PASSWORD = os.environ.get("P_PASSWORD", "admin")
WAIT_SECONDS = float(os.environ.get("PROMQL_ALERTS_WAIT_SECONDS", "30"))


def fail(message):
    raise RuntimeError(message)


def request(path, *, method="GET", params=None, body=None, auth=True, timeout=15,
            username=None, password=None):
    url = f"{BASE_URL}{path}"
    headers = {"Accept": "application/json"}
    if auth:
        credentials = (
            f"{username if username is not None else USERNAME}:"
            f"{password if password is not None else PASSWORD}"
        )
        token = base64.b64encode(credentials.encode()).decode()
        headers["Authorization"] = f"Basic {token}"
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    elif params is not None:
        url = f"{url}?{urllib.parse.urlencode(params, doseq=True)}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except urllib.error.URLError as exc:
        fail(f"cannot reach {path}: {exc}")


def decoded(status, raw, label):
    try:
        return json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(f"{label}: expected JSON, HTTP {status}: {exc}")


def data_success(status, raw, label):
    payload = decoded(status, raw, label)
    if status != 200 or not isinstance(payload, dict) or payload.get("status") != "success":
        fail(f"{label}: HTTP {status}: {payload}")
    return payload.get("data")


def ingest(stream, metric, suffix, values):
    stamp = (time.time_ns() // 1_000_000) * 1_000_000
    points = [
        {
            "timeUnixNano": str(stamp),
            "asDouble": value,
            "attributes": [{"key": "host", "value": {"stringValue": host}}],
        }
        for host, value in values.items()
    ]
    payload = {
        "resourceMetrics": [{
            "resource": {"attributes": [
                {"key": "service.name", "value": {"stringValue": f"promql-alerts-{suffix}"}},
                {"key": "service.instance.id", "value": {"stringValue": suffix}},
            ]},
            "scopeMetrics": [{"scope": {"name": "parseable-promql-alert-smoke"}, "metrics": [{
                "name": metric,
                "gauge": {"dataPoints": points},
            }]}],
        }],
    }
    url = f"{BASE_URL}/v1/metrics"
    token = base64.b64encode(f"{USERNAME}:{PASSWORD}".encode()).decode()
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={
        "Authorization": f"Basic {token}",
        "Content-Type": "application/json",
        "X-P-Stream": stream,
    }, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            if response.status not in (200, 202):
                fail(f"OTLP ingestion returned HTTP {response.status}")
    except urllib.error.HTTPError as exc:
        fail(f"OTLP ingestion failed, HTTP {exc.code}: {exc.read().decode(errors='replace')}")


class LocalWebhook:
    """Tiny loopback receiver that records request bodies for opt-in checks."""

    def __init__(self):
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen()
        self.port = self.sock.getsockname()[1]
        self.messages = []
        self.statuses = []
        self.fail_next = 0
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        self.sock.settimeout(0.25)
        while not self.stopped.is_set():
            try:
                client, _ = self.sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            with client:
                client.settimeout(2)
                try:
                    chunks = b""
                    while b"\r\n\r\n" not in chunks:
                        chunks += client.recv(4096)
                    head, body = chunks.split(b"\r\n\r\n", 1)
                    length = 0
                    for line in head.split(b"\r\n"):
                        if line.lower().startswith(b"content-length:"):
                            length = int(line.split(b":", 1)[1].strip())
                    while len(body) < length:
                        body += client.recv(4096)
                    self.messages.append(body[:length].decode(errors="replace"))
                    status = 503 if self.fail_next else 204
                    if self.fail_next:
                        self.fail_next -= 1
                    self.statuses.append(status)
                    reason = b"Service Unavailable" if status == 503 else b"No Content"
                    client.sendall(
                        b"HTTP/1.1 " + str(status).encode() + b" " + reason
                        + b"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                except (OSError, ValueError):
                    pass

    def close(self):
        self.stopped.set()
        self.sock.close()
        self.thread.join(timeout=2)


def instance(runtime, host):
    instances = runtime.get("instances") or {}
    for value in instances.values():
        if (value.get("labels") or {}).get("host") == host:
            return value
    return None


def wait_runtime(alert_id, predicate, label, timeout=WAIT_SECONDS):
    deadline = time.monotonic() + timeout
    latest = None
    while time.monotonic() < deadline:
        status, raw = request(f"{API_PREFIX}/alerts/{alert_id}")
        payload = decoded(status, raw, f"read alert ({label})")
        if status == 200:
            latest = payload.get("promqlRuntime") or payload.get("data", {}).get("promqlRuntime")
            if isinstance(latest, dict) and predicate(latest):
                return latest
        time.sleep(0.2)
    fail(f"timed out waiting for {label}; last runtime was {latest}")


def evaluate(alert_id, *, username=None, password=None):
    status, raw = request(
        f"{API_PREFIX}/alerts/{alert_id}/evaluate_alert", method="PUT",
        username=username, password=password,
    )
    if status != 200:
        fail(f"manual alert evaluation returned HTTP {status}: {raw.decode(errors='replace')}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--allow-local-webhook-policy", action="store_true",
        help="temporarily allow only 127.0.0.1/32 for this tenant to test notifications",
    )
    args = parser.parse_args()

    suffix = uuid.uuid4().hex[:12]
    stream = f"promql_alert_smoke_{suffix}"
    denied_stream = f"{stream}_restricted"
    role_name = f"promql_alert_smoke_role_{suffix}"
    user_name = f"promql_alert_smoke_user_{suffix}"
    owner_role_name = f"promql_alert_owner_role_{suffix}"
    owner_user_name = f"promql_alert_owner_user_{suffix}"
    metric = f"parseable_promql_alert_smoke_{suffix}"
    stream_created = False
    denied_stream_created = False
    role_created = False
    user_created = False
    owner_role_created = False
    owner_user_created = False
    alert_id = None
    no_data_alert_id = None
    owner_alert_id = None
    target_id = None
    original_policy = None
    policy_changed = False
    receiver = None
    cleanup_errors = []

    try:
        stream_created = True
        ingest(stream, metric, suffix, {"host-a": 9.0, "host-b": 3.0})
        denied_stream_created = True
        ingest(denied_stream, metric, suffix, {"host-a": 9.0})
        selector = f'{{__name__="{metric}"}}'

        targets = []
        if args.allow_local_webhook_policy:
            receiver = LocalWebhook()
            status, raw = request(f"{API_PREFIX}/alert-target-policy")
            original_policy = decoded(status, raw, "read outbound alert policy")
            if status != 200 or not isinstance(original_policy, dict):
                fail(f"could not read outbound alert policy: HTTP {status}: {original_policy}")
            local_policy = dict(original_policy)
            local_policy["allowPrivate"] = True
            local_policy["allowedDomains"] = []
            local_policy["allowedCidrs"] = ["127.0.0.1/32"]
            status, raw = request(f"{API_PREFIX}/alert-target-policy", method="PUT", body=local_policy)
            if status != 200:
                fail(f"could not allow temporary loopback target: HTTP {status}: {raw.decode(errors='replace')}")
            policy_changed = True
            target = {
                "name": f"PromQL alert smoke {suffix}",
                "type": "webhook",
                "endpoint": f"http://127.0.0.1:{receiver.port}/notify",
            }
            status, raw = request(f"{API_PREFIX}/targets", method="POST", body=target)
            created_target = decoded(status, raw, "create local webhook target")
            if status != 200:
                fail(f"could not create local webhook target: HTTP {status}: {created_target}")
            target_id = str(created_target.get("id") or created_target.get("data", {}).get("id"))
            if not target_id or target_id == "None":
                fail(f"target creation returned no ID: {created_target}")
            targets = [target_id]

        alert = {
            "severity": "high",
            "title": f"PromQL alert smoke {suffix}",
            "query": selector,
            "queryType": "promql",
            "datasets": [stream],
            "alertType": "threshold",
            "thresholdConfig": {"operator": ">", "value": 5},
            "promqlConfig": {"holdDuration": "2s"},
            "evalConfig": {"rollingWindow": {"evalStart": "1m", "evalEnd": "now", "evalFrequency": 1}},
            "notificationConfig": {"interval": 1},
            "targets": targets,
        }
        status, raw = request(f"{API_PREFIX}/alerts", method="POST", body=alert)
        created = decoded(status, raw, "create PromQL alert")
        if status != 200:
            fail(f"PromQL alert creation failed: HTTP {status}: {created}")
        alert_id = str(created.get("id") or created.get("data", {}).get("id"))
        if not alert_id or alert_id == "None":
            fail(f"alert creation returned no ID: {created}")

        # A reader restricted to a different dataset cannot inspect this rule.
        status, raw = request(
            f"{API_PREFIX}/role/{role_name}", method="PUT",
            body={"actions": [{"privilege": "reader", "resource": {"stream": denied_stream}}],
                  "roleType": "user"},
        )
        if status != 200:
            fail(f"could not create restricted test role: HTTP {status}: {raw.decode(errors='replace')}")
        role_created = True
        status, raw = request(f"{API_PREFIX}/user/{user_name}", method="POST", body=[role_name])
        if status != 200:
            fail(f"could not create restricted test user: HTTP {status}: {raw.decode(errors='replace')}")
        user_created = True
        try:
            restricted_password = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            restricted_password = raw.decode().strip().strip('"')
        status, raw = request(
            f"{API_PREFIX}/alerts/{alert_id}", username=user_name,
            password=restricted_password,
        )
        if status not in (401, 403):
            fail(f"restricted reader should not inspect an alert on another dataset; HTTP {status}: {raw.decode(errors='replace')}")

        # A brief breach enters pending, then clears when the same series drops.
        evaluate(alert_id)
        runtime = wait_runtime(alert_id, lambda r: instance(r, "host-a") is not None, "initial series evaluation")
        if instance(runtime, "host-a").get("state") not in ("pending", "firing"):
            fail(f"host-a should enter pending while over threshold: {runtime}")
        if instance(runtime, "host-b").get("state") not in ("resolved", "inactive", None):
            fail(f"host-b should remain inactive below threshold: {runtime}")

        ingest(stream, metric, suffix, {"host-a": 3.0, "host-b": 3.0})
        evaluate(alert_id)
        runtime = wait_runtime(
            alert_id,
            lambda r: instance(r, "host-a") is not None and instance(r, "host-a").get("state") == "resolved",
            "brief breach recovery",
        )
        if runtime.get("health") != "ok":
            fail(f"healthy vector evaluation returned unexpected health: {runtime}")

        # Host A fires only after a continuous breach; B starts its own clock later.
        ingest(stream, metric, suffix, {"host-a": 9.0, "host-b": 3.0})
        evaluate(alert_id)
        wait_runtime(alert_id, lambda r: instance(r, "host-a") is not None, "host-a pending")
        time.sleep(2.1)
        evaluate(alert_id)
        runtime = wait_runtime(
            alert_id,
            lambda r: instance(r, "host-a") is not None and instance(r, "host-a").get("state") == "firing",
            "host-a firing",
        )
        if args.allow_local_webhook_policy:
            deadline = time.monotonic() + WAIT_SECONDS
            while time.monotonic() < deadline and not receiver.messages:
                time.sleep(0.1)
            if not receiver.messages:
                fail("local webhook did not receive a firing notification")

        ingest(stream, metric, suffix, {"host-a": 9.0, "host-b": 9.0})
        evaluate(alert_id)
        runtime = wait_runtime(
            alert_id,
            lambda r: instance(r, "host-b") is not None and instance(r, "host-b").get("state") in ("pending", "firing"),
            "host-b independent pending state",
        )
        if instance(runtime, "host-a").get("state") != "firing":
            fail(f"host-a firing state was affected by host-b transition: {runtime}")
        time.sleep(2.1)
        evaluate(alert_id)
        runtime = wait_runtime(
            alert_id,
            lambda r: instance(r, "host-b") is not None and instance(r, "host-b").get("state") == "firing",
            "host-b firing",
        )

        # Recovery is emitted once for the resolved per-series transition.
        ingest(stream, metric, suffix, {"host-a": 3.0, "host-b": 9.0})
        evaluate(alert_id)
        runtime = wait_runtime(
            alert_id,
            lambda r: instance(r, "host-a") is not None and instance(r, "host-a").get("state") == "resolved",
            "host-a recovery while host-b remains firing",
        )
        if instance(runtime, "host-b").get("state") != "firing":
            fail(f"recovering host-a unexpectedly changed host-b state: {runtime}")
        if args.allow_local_webhook_policy:
            deadline = time.monotonic() + WAIT_SECONDS
            while time.monotonic() < deadline and len(receiver.messages) < 3:
                time.sleep(0.1)
            if not any("resolved" in message.lower() for message in receiver.messages):
                fail(f"local webhook did not receive a recovery notification: {receiver.messages}")

        # Create a second rule through a scoped writer so its scheduled identity
        # is that user, not the administrator running this smoke test.
        status, raw = request(
            f"{API_PREFIX}/role/{owner_role_name}", method="PUT",
            body={"actions": [{"privilege": "writer", "resource": {"stream": stream}}],
                  "roleType": "user"},
        )
        if status != 200:
            fail(f"could not create scoped alert-owner role: HTTP {status}: {raw.decode(errors='replace')}")
        owner_role_created = True
        status, raw = request(f"{API_PREFIX}/user/{owner_user_name}", method="POST", body=[owner_role_name])
        if status != 200:
            fail(f"could not create scoped alert-owner user: HTTP {status}: {raw.decode(errors='replace')}")
        owner_user_created = True
        try:
            owner_password = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            owner_password = raw.decode().strip().strip('"')
        owner_alert = {**alert, "title": f"PromQL owner smoke {suffix}"}
        status, raw = request(
            f"{API_PREFIX}/alerts", method="POST", body=owner_alert,
            username=owner_user_name, password=owner_password,
        )
        owner_created = decoded(status, raw, "create owner-scoped alert")
        if status != 200:
            fail(f"scoped writer could not create its alert: HTTP {status}: {owner_created}")
        owner_alert_id = str(owner_created.get("id") or owner_created.get("data", {}).get("id"))
        if not owner_alert_id or owner_alert_id == "None":
            fail(f"owner-scoped alert creation returned no ID: {owner_created}")
        evaluate(owner_alert_id, username=owner_user_name, password=owner_password)
        wait_runtime(
            owner_alert_id,
            lambda r: instance(r, "host-b") is not None and instance(r, "host-b").get("state") in ("pending", "firing"),
            "owner rule pending",
        )
        time.sleep(2.1)
        status_count_before_retry = len(receiver.statuses) if args.allow_local_webhook_policy else 0
        if args.allow_local_webhook_policy:
            receiver.fail_next = 1
        evaluate(owner_alert_id, username=owner_user_name, password=owner_password)
        owner_runtime = wait_runtime(
            owner_alert_id,
            lambda r: instance(r, "host-b") is not None
            and instance(r, "host-b").get("state") == "firing"
            and (
                not args.allow_local_webhook_policy
                or any(item.get("error") for item in r.get("deliveries", []))
            ),
            "owner rule firing and failed webhook delivery persisted",
        )
        if args.allow_local_webhook_policy:
            failed_delivery = next(item for item in owner_runtime["deliveries"] if item.get("error"))
            if failed_delivery.get("attempts") != 1 or 503 not in receiver.statuses[status_count_before_retry:]:
                fail(f"first webhook failure was not recorded as one persisted attempt: {owner_runtime}, HTTP statuses {receiver.statuses}")
            evaluate(owner_alert_id, username=owner_user_name, password=owner_password)
            owner_runtime = wait_runtime(
                owner_alert_id,
                lambda r: r.get("deliveries") == [],
                "successful retry clears the persisted webhook queue",
            )
            if 204 not in receiver.statuses[status_count_before_retry:]:
                fail(f"failed webhook notification was not retried successfully: {receiver.statuses}")

        # Keep rule-management permission but remove Query access to its dataset.
        # Admin manual evaluation requeues scheduled work without changing the
        # durable owner captured when the scoped user created this rule.
        status, raw = request(
            f"{API_PREFIX}/role/{owner_role_name}", method="PUT",
            body={"actions": [{"privilege": "writer", "resource": {"stream": denied_stream}}],
                  "roleType": "user"},
        )
        if status != 200:
            fail(f"could not revoke alert owner's dataset query access: HTTP {status}: {raw.decode(errors='replace')}")
        status, raw = request(
            f"{API_PREFIX}/alerts/{owner_alert_id}/evaluate_alert", method="PUT",
        )
        if status != 200:
            fail(f"could not requeue owner alert after permission change: HTTP {status}: {raw.decode(errors='replace')}")
        owner_runtime = wait_runtime(
            owner_alert_id,
            lambda r: r.get("health") == "error",
            "revoked-owner evaluation error",
        )
        owner_instance = instance(owner_runtime, "host-b")
        if owner_instance is None or owner_instance.get("state") != "firing":
            fail(f"revoking Query access should retain the owner's firing instance: {owner_runtime}")
        if args.allow_local_webhook_policy:
            time.sleep(0.5)
            deliveries_after_restart = len(receiver.messages)
            time.sleep(0.5)
            if len(receiver.messages) != deliveries_after_restart:
                fail(f"revoked owner caused a new webhook delivery without a state transition: {receiver.messages}")

        # A separate empty-vector rule reports No Data on its first evaluation.
        no_data_rule = {
            **alert,
            "title": f"PromQL no-data smoke {suffix}",
            "query": f'{selector[:-1]},host="missing"}}',
            "targets": [],
        }
        status, raw = request(f"{API_PREFIX}/alerts", method="POST", body=no_data_rule)
        no_data_created = decoded(status, raw, "create No Data alert")
        if status != 200:
            fail(f"No Data alert creation failed: HTTP {status}: {no_data_created}")
        no_data_alert_id = str(no_data_created.get("id") or no_data_created.get("data", {}).get("id"))
        if not no_data_alert_id or no_data_alert_id == "None":
            fail(f"No Data alert creation returned no ID: {no_data_created}")
        evaluate(no_data_alert_id)
        runtime = wait_runtime(no_data_alert_id, lambda r: r.get("health") == "noData", "No Data health")
        if runtime.get("instances"):
            fail(f"empty vector should not create alert instances: {runtime}")

        # Removing the dataset makes the firing rule's next evaluation fail.
        # Its existing series remains firing through the error discontinuity.
        status, raw = request(
            f"{API_PREFIX}/logstream/{urllib.parse.quote(stream, safe='')}",
            method="DELETE",
        )
        if status not in (200, 202, 204):
            fail(f"could not remove fixture stream to exercise evaluation error: HTTP {status}: {raw.decode(errors='replace')}")
        stream_created = False
        evaluate(alert_id)
        runtime = wait_runtime(alert_id, lambda r: r.get("health") == "error", "evaluation error health")
        if instance(runtime, "host-b") is None or instance(runtime, "host-b").get("state") != "firing":
            fail(f"evaluation error should retain host-b firing state: {runtime}")

        print("PASS: PromQL alert lifecycle, No Data, scoped-owner permission revocation, and error-state retention")
        if args.allow_local_webhook_policy:
            print("PASS: loopback webhook received firing and recovery notifications without redelivery after revocation")
    finally:
        if alert_id:
            status, raw = request(f"{API_PREFIX}/alerts/{alert_id}", method="DELETE")
            if status not in (200, 204):
                cleanup_errors.append(f"alert DELETE returned HTTP {status}: {raw.decode(errors='replace')}")
        if no_data_alert_id:
            status, raw = request(f"{API_PREFIX}/alerts/{no_data_alert_id}", method="DELETE")
            if status not in (200, 204):
                cleanup_errors.append(f"No Data alert DELETE returned HTTP {status}: {raw.decode(errors='replace')}")
        if owner_alert_id:
            status, raw = request(f"{API_PREFIX}/alerts/{owner_alert_id}", method="DELETE")
            if status not in (200, 204):
                cleanup_errors.append(f"owner alert DELETE returned HTTP {status}: {raw.decode(errors='replace')}")
        if target_id:
            status, raw = request(f"{API_PREFIX}/targets/{target_id}", method="DELETE")
            if status not in (200, 204):
                cleanup_errors.append(f"target DELETE returned HTTP {status}: {raw.decode(errors='replace')}")
        if user_created:
            status, raw = request(f"{API_PREFIX}/user/{user_name}", method="DELETE")
            if status not in (200, 204):
                cleanup_errors.append(f"test user DELETE returned HTTP {status}: {raw.decode(errors='replace')}")
        if owner_user_created:
            status, raw = request(f"{API_PREFIX}/user/{owner_user_name}", method="DELETE")
            if status not in (200, 204):
                cleanup_errors.append(f"owner user DELETE returned HTTP {status}: {raw.decode(errors='replace')}")
        if role_created:
            status, raw = request(f"{API_PREFIX}/role/{role_name}", method="DELETE")
            if status not in (200, 204):
                cleanup_errors.append(f"test role DELETE returned HTTP {status}: {raw.decode(errors='replace')}")
        if owner_role_created:
            status, raw = request(f"{API_PREFIX}/role/{owner_role_name}", method="DELETE")
            if status not in (200, 204):
                cleanup_errors.append(f"owner role DELETE returned HTTP {status}: {raw.decode(errors='replace')}")
        if policy_changed and original_policy is not None:
            status, raw = request(f"{API_PREFIX}/alert-target-policy", method="PUT", body=original_policy)
            if status != 200:
                cleanup_errors.append(f"outbound policy restore returned HTTP {status}: {raw.decode(errors='replace')}")
        if receiver:
            receiver.close()
        if stream_created:
            status, raw = request(f"{API_PREFIX}/logstream/{urllib.parse.quote(stream, safe='')}", method="DELETE")
            if status not in (200, 202, 204):
                cleanup_errors.append(f"fixture stream DELETE returned HTTP {status}: {raw.decode(errors='replace')}")
        if denied_stream_created:
            status, raw = request(f"{API_PREFIX}/logstream/{urllib.parse.quote(denied_stream, safe='')}", method="DELETE")
            if status not in (200, 202, 204):
                cleanup_errors.append(f"restricted fixture stream DELETE returned HTTP {status}: {raw.decode(errors='replace')}")
        if cleanup_errors:
            print("CLEANUP FAILED: " + "; ".join(cleanup_errors), file=sys.stderr)
            raise RuntimeError("PromQL alert smoke could not remove all temporary resources")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        raise SystemExit(1)
