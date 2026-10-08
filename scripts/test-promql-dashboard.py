#!/usr/bin/env python3
"""Exercise the PromQL dashboard client contract against a running Parseable."""

import base64
from concurrent.futures import ThreadPoolExecutor
import json
import os
import sys
import time
from threading import Barrier
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
WAIT_SECONDS = float(os.environ.get("PROMQL_DASHBOARD_WAIT_SECONDS", "30"))


def request(
    path,
    *,
    method="GET",
    params=None,
    body=None,
    stream_header=None,
    auth=True,
    content_type=None,
    username=None,
    password=None,
):
    url = f"{BASE_URL}{path}"
    headers = {"Accept": "application/json"}
    if stream_header:
        headers["X-P-Stream"] = stream_header
    if auth:
        auth_username = username if username is not None else USERNAME
        auth_password = password if password is not None else PASSWORD
        token = base64.b64encode(f"{auth_username}:{auth_password}".encode()).decode()
        headers["Authorization"] = f"Basic {token}"
    data = None
    if body is not None:
        if content_type == "application/x-www-form-urlencoded":
            data = urllib.parse.urlencode(body, doseq=True).encode()
        else:
            data = json.dumps(body).encode()
        headers["Content-Type"] = content_type or "application/json"
    elif params is not None:
        url = f"{url}?{urllib.parse.urlencode(params, doseq=True)}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except urllib.error.URLError as exc:
        fail(f"cannot reach {path}: {exc}")


def decode(status, raw, label):
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(f"{label}: expected JSON (HTTP {status}): {exc}")


def fail(message):
    print(f"FAIL: {message}", file=sys.stderr)
    raise RuntimeError(message)


def expect_success(status, raw, label):
    payload = decode(status, raw, label)
    if status != 200 or not isinstance(payload, dict) or payload.get("status") != "success":
        fail(f"{label}: HTTP {status}: {payload}")
    return payload.get("data")


def ulid():
    alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    value = (int(time.time() * 1000) << 80) | int.from_bytes(uuid.uuid4().bytes[:10], "big")
    encoded = ""
    for _ in range(26):
        encoded = alphabet[value & 31] + encoded
        value >>= 5
    return encoded


def main():
    suffix = uuid.uuid4().hex[:12]
    stream = f"promql_dashboard_{suffix}"
    denied_stream = f"{stream}_denied"
    metric = f"parseable.promql.dashboard.{suffix}"
    decoy_metric = f"parseable.promql.decoy.{suffix}"
    job = f"promql-dashboard-{suffix}"
    dashboard_id = None
    stream_created = False
    denied_stream_created = False
    role_name = f"promql_dashboard_role_{suffix}"
    role_created = False
    user_name = f"promql_dashboard_user_{suffix}"
    user_created = False
    now_ns = (time.time_ns() // 1_000_000) * 1_000_000
    metric_query = f'{{__name__="{metric}",job="{job}",scenario="blue"}}'
    tile_id = ulid()

    try:
        points = [
            (now_ns - 20_000_000_000, 1.25, "blue"),
            (now_ns - 10_000_000_000, 2.5, "blue"),
            (now_ns - 10_000_000_000, 9.0, "red"),
        ]
        otlp = {
            "resourceMetrics": [{
                "resource": {"attributes": [
                    {"key": "service.name", "value": {"stringValue": job}},
                    {"key": "service.instance.id", "value": {"stringValue": suffix}},
                ]},
                "scopeMetrics": [{"scope": {"name": "parseable-promql-dashboard-smoke"}, "metrics": [
                    {
                        "name": metric,
                        "gauge": {"dataPoints": [
                            {
                                "timeUnixNano": str(timestamp),
                                "asDouble": value,
                                "attributes": [{"key": "scenario", "value": {"stringValue": scenario}}],
                            }
                            for timestamp, value, scenario in points
                        ]},
                    },
                    {
                        "name": decoy_metric,
                        "gauge": {"dataPoints": [{
                            "timeUnixNano": str(now_ns - 5_000_000_000),
                            "asDouble": 99.0,
                            "attributes": [{"key": "scenario", "value": {"stringValue": "blue"}}],
                        }]},
                    },
                ]}],
            }],
        }
        ingest_url = f"{BASE_URL}/v1/metrics"
        token = base64.b64encode(f"{USERNAME}:{PASSWORD}".encode()).decode()
        ingest_req = urllib.request.Request(
            ingest_url,
            data=json.dumps(otlp).encode(),
            headers={
                "Authorization": f"Basic {token}",
                "Content-Type": "application/json",
                "X-P-Stream": stream,
            },
            method="POST",
        )
        stream_created = True
        try:
            with urllib.request.urlopen(ingest_req, timeout=20) as response:
                if response.status not in (200, 202):
                    fail(f"OTLP ingestion returned HTTP {response.status}")
        except urllib.error.HTTPError as exc:
            fail(f"OTLP ingestion failed with HTTP {exc.code}: {exc.read().decode(errors='replace')}")

        # A second, real OTLP dataset gives the restricted reader an existing
        # dataset it must not be able to inspect, even on a fresh server.
        denied_stream_created = True
        denied_ingest_req = urllib.request.Request(
            ingest_url,
            data=json.dumps(otlp).encode(),
            headers={
                "Authorization": f"Basic {token}",
                "Content-Type": "application/json",
                "X-P-Stream": denied_stream,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(denied_ingest_req, timeout=20) as response:
                if response.status not in (200, 202):
                    fail(f"denied-dataset fixture ingestion returned HTTP {response.status}")
        except urllib.error.HTTPError as exc:
            fail(f"denied-dataset fixture ingestion failed with HTTP {exc.code}: {exc.read().decode(errors='replace')}")

        instant_params = {"query": metric_query, "time": f"{now_ns / 1_000_000_000 + 1:.3f}", "stream": stream}
        instant = None
        deadline = time.monotonic() + WAIT_SECONDS
        while time.monotonic() < deadline:
            status, raw = request("/prometheus/api/v1/query", params=instant_params)
            payload = decode(status, raw, "dashboard instant query")
            if status == 200 and payload.get("status") == "success":
                data = payload.get("data", {})
                if data.get("resultType") == "vector" and len(data.get("result", [])) == 1:
                    instant = data["result"][0]
                    break
            time.sleep(0.5)
        if instant is None:
            fail(f"dashboard stream-parameter query was not ready within {WAIT_SECONDS:g}s")
        if (
            instant.get("metric", {}).get("__name__") != metric
            or instant.get("metric", {}).get("scenario") != "blue"
            or float(instant["value"][1]) != 2.5
        ):
            fail(f"dashboard instant query returned unexpected data: {instant}")

        conflict_status, conflict_raw = request(
            "/prometheus/api/v1/query",
            params={"query": metric_query, "stream": stream + "_other"},
            stream_header=stream,
        )
        conflict = decode(conflict_status, conflict_raw, "conflicting stream selection")
        if conflict_status != 400 or not isinstance(conflict, dict) or conflict.get("status") != "error":
            fail(f"conflicting stream header/query parameter should return HTTP 400, got {conflict_status}: {conflict}")

        unauth_status, _ = request(
            "/prometheus/api/v1/query",
            params={"query": metric_query, "stream": stream},
            auth=False,
        )
        if unauth_status not in (401, 403):
            fail(f"unauthenticated dashboard query should return HTTP 401/403, got {unauth_status}")

        start_sec = f"{now_ns / 1_000_000_000 - 25:.3f}"
        end_sec = f"{now_ns / 1_000_000_000 + 1:.3f}"
        range_params = {"query": metric_query, "start": start_sec, "end": end_sec, "step": "5s", "stream": stream}
        status, raw = request("/prometheus/api/v1/query_range", params=range_params)
        range_data = expect_success(status, raw, "dashboard range GET")
        if range_data.get("resultType") != "matrix" or len(range_data.get("result", [])) != 1:
            fail(f"dashboard range GET returned unexpected data: {range_data}")
        if range_data["result"][0].get("metric", {}).get("__name__") != metric:
            fail(f"dashboard range GET returned the wrong dotted metric: {range_data}")

        # Dashboard widgets use POST when the expression makes a long URL.
        post_params = dict(range_params)
        post_params.pop("stream")
        status, raw = request(
            "/prometheus/api/v1/query_range",
            method="POST",
            body={**post_params, "stream": stream},
            content_type="application/x-www-form-urlencoded",
        )
        post_data = expect_success(status, raw, "dashboard range POST")
        if post_data != range_data:
            fail("dashboard GET and form POST returned different range data")

        # Simulate eight dashboard panels refreshing together. Keep the scan
        # tight around the fixture and use the quoted dotted-name selector that
        # must push down to one metric in storage.
        burst_params = {**range_params, "step": "10ms"}
        start_barrier = Barrier(8)

        def run_panel_query(_):
            start_barrier.wait(timeout=10)
            return request("/prometheus/api/v1/query_range", params=burst_params)

        with ThreadPoolExecutor(max_workers=8) as executor:
            burst_results = list(executor.map(run_panel_query, range(8)))
        for index, (burst_status, burst_raw) in enumerate(burst_results):
            burst_data = expect_success(burst_status, burst_raw, f"dashboard burst panel {index + 1}")
            if burst_data.get("resultType") != "matrix" or len(burst_data.get("result", [])) != 1:
                fail(f"dashboard burst panel {index + 1} returned unexpected data: {burst_data}")
            if burst_data["result"][0].get("metric", {}).get("__name__") != metric:
                fail(f"dashboard burst panel {index + 1} returned the wrong dotted metric: {burst_data}")

        common = {
            "stream": stream,
            "start": start_sec,
            "end": end_sec,
            "match[]": [f'{{__name__="{metric}",scenario="blue"}}'],
            "limit": 1000,
        }
        status, raw = request("/prometheus/api/v1/labels", params=common)
        labels = expect_success(status, raw, "dashboard label discovery")
        if not {"__name__", "scenario", "job"}.issubset(set(labels)):
            fail(f"dashboard label discovery omitted expected labels: {labels}")
        status, raw = request(f"/prometheus/api/v1/label/scenario/values", params=common)
        values = expect_success(status, raw, "dashboard label values")
        if "blue" not in values or "red" in values:
            fail(f"filtered dashboard label values were unexpected: {values}")

        tile = {
            "tile_id": tile_id,
            "tileType": "promql",
            "dbName": stream,
            "chartQuery": [metric_query],
            "promqlQueryType": ["range"],
        }
        dashboard = {"title": f"PromQL dashboard smoke {suffix}", "tiles": [tile]}
        status, raw = request(f"{API_PREFIX}/dashboards", method="POST", body=dashboard)
        created = decode(status, raw, "create dashboard")
        if status != 200 or not isinstance(created, dict) or not created.get("dashboardId"):
            fail(f"create dashboard failed: HTTP {status}: {created}")
        dashboard_id = created["dashboardId"]

        fetched_status, fetched_raw = request(f"{API_PREFIX}/dashboards/{dashboard_id}")
        fetched = decode(fetched_status, fetched_raw, "read dashboard")
        if fetched_status != 200 or not fetched.get("tiles") or fetched["tiles"][0].get("chartQuery") != [metric_query]:
            fail(f"saved PromQL tile did not round-trip: HTTP {fetched_status}: {fetched}")

        updated = {**fetched, "title": f"PromQL dashboard smoke edited {suffix}"}
        updated["tiles"][0]["chartQuery"] = [f"{metric_query} * 2"]
        status, raw = request(f"{API_PREFIX}/dashboards/{dashboard_id}", method="PUT", body=updated)
        edited = decode(status, raw, "edit dashboard")
        if status != 200 or edited.get("title") != updated["title"] or edited.get("tiles", [{}])[0].get("chartQuery") != updated["tiles"][0]["chartQuery"]:
            fail(f"edit dashboard failed: HTTP {status}: {edited}")

        # Verify that all PromQL entry points enforce the selected dataset. The
        # temporary reader may query only this fixture stream.
        status, raw = request(
            f"{API_PREFIX}/role/{role_name}",
            method="PUT",
            body={
                "actions": [{"privilege": "reader", "resource": {"stream": stream}}],
                "roleType": "user",
            },
        )
        role_created = status == 200
        if status != 200:
            fail(f"create restricted test role failed: HTTP {status}: {raw.decode(errors='replace')}")

        user_created = True
        status, raw = request(
            f"{API_PREFIX}/user/{user_name}",
            method="POST",
            body=[role_name],
        )
        if status != 200:
            fail(f"create restricted test user failed: HTTP {status}: {raw.decode(errors='replace')}")
        try:
            restricted_password = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            restricted_password = raw.decode().strip().strip('"')
        if not isinstance(restricted_password, str) or not restricted_password:
            fail("restricted test user creation returned no usable password")

        allowed_query = {
            "query": metric_query,
            "time": f"{now_ns / 1_000_000_000 + 1:.3f}",
            "stream": stream,
        }
        status, raw = request(
            "/prometheus/api/v1/query",
            params=allowed_query,
            username=user_name,
            password=restricted_password,
        )
        allowed = expect_success(status, raw, "restricted stream alias query")
        if allowed.get("resultType") != "vector" or len(allowed.get("result", [])) != 1:
            fail(f"restricted reader could not query its assigned stream: {allowed}")

        metadata_args = {
            "stream": stream,
            "start": start_sec,
            "end": end_sec,
            "match[]": [f'{{__name__="{metric}",scenario="blue"}}'],
            "limit": 1000,
        }
        status, raw = request(
            "/prometheus/api/v1/labels",
            params=metadata_args,
            username=user_name,
            password=restricted_password,
        )
        allowed_labels = expect_success(status, raw, "restricted label discovery")
        if "scenario" not in allowed_labels:
            fail(f"restricted label discovery omitted the fixture label: {allowed_labels}")
        status, raw = request(
            "/prometheus/api/v1/label/scenario/values",
            params=metadata_args,
            username=user_name,
            password=restricted_password,
        )
        allowed_values = expect_success(status, raw, "restricted label-value discovery")
        if "blue" not in allowed_values or "red" in allowed_values:
            fail(f"restricted label-value discovery returned unexpected values: {allowed_values}")

        denied_args = {**metadata_args, "stream": denied_stream}
        for endpoint in (
            "/prometheus/api/v1/labels",
            "/prometheus/api/v1/label/scenario/values",
            "/prometheus/api/v1/query",
        ):
            params = denied_args if endpoint != "/prometheus/api/v1/query" else {
                "query": metric_query,
                "time": f"{now_ns / 1_000_000_000 + 1:.3f}",
                "stream": denied_stream,
            }
            denied_status, denied_raw = request(
                endpoint,
                params=params,
                username=user_name,
                password=restricted_password,
            )
            if denied_status != 401:
                fail(
                    f"restricted reader should receive HTTP 401 for {endpoint} on another dataset, "
                    f"got {denied_status}: {denied_raw.decode(errors='replace')}"
                )

        print("PASS: dotted metric selectors, eight-panel range burst, dashboard CRUD, and restricted-dataset authorization")
    finally:
        cleanup_errors = []
        if dashboard_id:
            status, raw = request(f"{API_PREFIX}/dashboards/{dashboard_id}", method="DELETE")
            if status not in (200, 204):
                cleanup_errors.append(f"dashboard DELETE returned HTTP {status}: {raw.decode(errors='replace')}")
        if user_created:
            status, raw = request(f"{API_PREFIX}/user/{user_name}", method="DELETE")
            if status not in (200, 204):
                cleanup_errors.append(f"test user DELETE returned HTTP {status}: {raw.decode(errors='replace')}")
        if role_created:
            status, raw = request(f"{API_PREFIX}/role/{role_name}", method="DELETE")
            if status not in (200, 204):
                cleanup_errors.append(f"test role DELETE returned HTTP {status}: {raw.decode(errors='replace')}")
        if stream_created:
            status, raw = request(f"{API_PREFIX}/logstream/{urllib.parse.quote(stream, safe='')}", method="DELETE")
            if status not in (200, 202, 204):
                cleanup_errors.append(f"stream DELETE returned HTTP {status}: {raw.decode(errors='replace')}")
        if denied_stream_created:
            status, raw = request(f"{API_PREFIX}/logstream/{urllib.parse.quote(denied_stream, safe='')}", method="DELETE")
            if status not in (200, 202, 204):
                cleanup_errors.append(f"denied test stream DELETE returned HTTP {status}: {raw.decode(errors='replace')}")
        if cleanup_errors:
            print("CLEANUP FAILED: " + "; ".join(cleanup_errors), file=sys.stderr)
            raise RuntimeError("dashboard smoke could not remove all temporary resources")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError:
        raise SystemExit(1)
