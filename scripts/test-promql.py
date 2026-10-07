#!/usr/bin/env python3
"""End-to-end smoke check for OTLP ingestion and the community PromQL API."""

import base64
import json
import os
import sys
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
USERNAME = os.environ.get("P_USERNAME", "admin")
PASSWORD = os.environ.get("P_PASSWORD", "admin")
WAIT_SECONDS = float(os.environ.get("PROMQL_SMOKE_WAIT_SECONDS", "30"))


def request(path, params=None, *, method="GET", body=None, stream=None, auth=True):
    url = f"{BASE_URL}{path}"
    headers = {"Accept": "application/json"}
    if stream:
        headers["X-P-Stream"] = stream
    if auth:
        token = base64.b64encode(f"{USERNAME}:{PASSWORD}".encode()).decode()
        headers["Authorization"] = f"Basic {token}"
    if body is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        data = urllib.parse.urlencode(body).encode()
    elif params is not None:
        url = f"{url}?{urllib.parse.urlencode(params)}"
        data = None
    else:
        data = None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def decode_json(status, body, description):
    try:
        return json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(f"{description}: expected JSON (HTTP {status}): {exc}")


def fail(message):
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def assert_success(status, payload, description):
    if status != 200 or payload.get("status") != "success":
        fail(f"{description}: HTTP {status}: {payload}")
    return payload.get("data", {})


def main():
    suffix = uuid.uuid4().hex[:12]
    stream = f"promql_smoke_{suffix}"
    metric = f"parseable_promql_smoke_{suffix}"
    counter = f"parseable_promql_counter_{suffix}"
    job = f"promql-smoke-{suffix}"
    # Backfill a deterministic, millisecond-aligned sample set one day ago.
    now_ns = ((time.time_ns() - 86_400_000_000_000) // 1_000_000) * 1_000_000
    # Two samples for one series plus a second series to check label filtering.
    points = [
        (now_ns - 20_000_000_000, 1.25, "blue"),
        (now_ns - 10_000_000_000, 2.5, "blue"),
        (now_ns - 10_000_000_000, 9.0, "red"),
    ]
    counter_points = [
        (now_ns - 40_000_000_000, 100.0),
        (now_ns - 30_000_000_000, 115.0),
        (now_ns - 20_000_000_000, 3.0),
    ]
    payload = {
        "resourceMetrics": [
            {
                "resource": {
                    "attributes": [
                        {"key": "service.name", "value": {"stringValue": job}},
                        {"key": "service.instance.id", "value": {"stringValue": suffix}},
                    ]
                },
                "scopeMetrics": [
                    {
                        "scope": {"name": "parseable-promql-smoke"},
                        "metrics": [
                            {
                                "name": metric,
                                "gauge": {
                                    "dataPoints": [
                                        {
                                            "timeUnixNano": str(timestamp),
                                            "asDouble": value,
                                            "attributes": [
                                                {"key": "scenario", "value": {"stringValue": scenario}}
                                            ],
                                        }
                                        for timestamp, value, scenario in points
                                    ]
                                },
                            },
                            {
                                "name": counter,
                                "sum": {
                                    "aggregationTemporality": 2,
                                    "isMonotonic": True,
                                    "dataPoints": [
                                        {
                                            "startTimeUnixNano": str(now_ns - 60_000_000_000),
                                            "timeUnixNano": str(timestamp),
                                            "asDouble": value,
                                            "attributes": [
                                                {"key": "scenario", "value": {"stringValue": "counter"}}
                                            ],
                                        }
                                        for timestamp, value in counter_points
                                    ],
                                },
                            },
                        ],
                    }
                ],
            }
        ]
    }

    ingest_url = f"{BASE_URL}/v1/metrics"
    token = base64.b64encode(f"{USERNAME}:{PASSWORD}".encode()).decode()
    ingest_req = urllib.request.Request(
        ingest_url,
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Basic {token}",
            "Content-Type": "application/json",
            "X-P-Stream": stream,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(ingest_req, timeout=20) as response:
            if response.status not in (200, 202):
                fail(f"OTLP ingestion returned HTTP {response.status}")
    except urllib.error.HTTPError as exc:
        fail(f"OTLP ingestion failed with HTTP {exc.code}: {exc.read().decode(errors='replace')}")
    except urllib.error.URLError as exc:
        fail(f"cannot reach OTLP ingestion endpoint: {exc}")

    query = f'{metric}{{scenario="blue",job="{job}"}}'
    query_time = now_ns / 1_000_000_000 + 60
    instant_params = {"query": query, "time": f"{query_time:.3f}"}
    deadline = time.monotonic() + WAIT_SECONDS
    instant = None
    while time.monotonic() < deadline:
        status, body = request(
            "/prometheus/api/v1/query", instant_params, stream=stream
        )
        response = decode_json(status, body, "instant query")
        if status == 200 and response.get("status") == "success":
            data = response.get("data", {})
            result = data.get("result", [])
            if data.get("resultType") == "vector" and len(result) == 1:
                instant = result[0]
                break
        time.sleep(0.5)
    if instant is None:
        fail(f"ingested series did not become queryable within {WAIT_SECONDS:g}s")
    labels = instant.get("metric", {})
    if labels.get("__name__") != metric or labels.get("scenario") != "blue" or labels.get("job") != job:
        fail(f"instant query returned unexpected labels: {labels}")
    value = instant.get("value", [None, None])[1]
    if not abs(float(value) - 2.5) < 1e-9:
        fail(f"instant query returned {value!r}, expected latest blue sample 2.5")

    counter_query = f'{counter}{{scenario="counter",job="{job}"}}'
    counter_time = now_ns / 1_000_000_000 + 2
    for function in ("rate", "increase", "resets"):
        status, body = request(
            "/prometheus/api/v1/query",
            {"query": f"{function}({counter_query}[1m])", "time": f"{counter_time:.3f}"},
            stream=stream,
        )
        response = decode_json(status, body, f"{function} query")
        data = assert_success(status, response, f"{function} query")
        result = data.get("result", [])
        if data.get("resultType") != "vector" or len(result) != 1:
            fail(f"{function} did not return the counter series: {data}")
        result_value = float(result[0]["value"][1])
        expected = {"rate": 0.45, "increase": 27.0, "resets": 1.0}[function]
        if not abs(result_value - expected) < 1e-9:
            fail(f"{function} returned {result[0]['value'][1]!r}, expected {expected:g}")

    range_params = {
        "query": query,
        "start": f"{now_ns / 1_000_000_000 - 30:.3f}",
        "end": f"{now_ns / 1_000_000_000 + 5:.3f}",
        "step": "5s",
    }
    status, body = request(
        "/prometheus/api/v1/query_range", method="POST", body=range_params, stream=stream
    )
    response = decode_json(status, body, "range query")
    data = assert_success(status, response, "range query")
    series = data.get("result", [])
    if data.get("resultType") != "matrix" or len(series) != 1:
        fail(f"range query did not return one filtered series: {data}")
    range_labels = series[0].get("metric", {})
    if range_labels.get("scenario") != "blue" or range_labels.get("job") != job:
        fail(f"range query returned unexpected labels: {range_labels}")
    values = series[0].get("values", [])
    if not values or not any(float(sample[1]) == 2.5 for sample in values):
        fail(f"range query did not include the blue sample: {values}")

    status, body = request(
        "/prometheus/api/v1/query",
        {"query": "sum("},
        stream=stream,
    )
    response = decode_json(status, body, "malformed-query response")
    if status != 400 or response.get("status") != "error" or not response.get("errorType"):
        fail(f"malformed query did not return a Prometheus error (HTTP 400): {response}")

    status, body = request(
        "/prometheus/api/v1/query",
        {"query": f"topk(1, {metric})"},
        stream=stream,
    )
    response = decode_json(status, body, "evaluation-error response")
    if status != 422 or response.get("status") != "error" or not response.get("errorType"):
        fail(f"invalid evaluation did not return a Prometheus error (HTTP 422): {response}")

    invalid_range = {
        "query": query,
        "start": f"{now_ns / 1_000_000_000 - 30:.3f}",
        "end": f"{now_ns / 1_000_000_000 + 5:.3f}",
        "step": "0",
    }
    status, body = request(
        "/prometheus/api/v1/query_range",
        method="POST",
        body=invalid_range,
        stream=stream,
    )
    response = decode_json(status, body, "invalid-step response")
    if status != 400 or response.get("status") != "error" or not response.get("errorType"):
        fail(f"invalid step did not return a Prometheus error (HTTP 400): {response}")

    status, _ = request(
        "/prometheus/api/v1/query",
        {"query": metric},
        stream=stream,
        auth=False,
    )
    if status not in (401, 403):
        fail(f"unauthenticated PromQL request returned HTTP {status}, expected 401 or 403")

    print(f"PASS: OTLP ingestion, instant/range PromQL, label filtering, rate/increase/reset, parser errors, and auth check ({stream})")


if __name__ == "__main__":
    main()
