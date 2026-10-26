#!/usr/bin/env python3
"""HTTP smoke test of the generic flattening limits against a real Parseable binary.

Starts `<binary> local-store` on 127.0.0.1 (ephemeral ports for HTTP, gRPC, Arrow Flight
and query gRPC, temporary data and staging directories, small flatten caps), then for plain
JSON (on `/api/v1/ingest` and `/api/v1/logstream/{name}`), a known log format, a custom
partitioned stream, Kinesis, OTEL JSON logs and schema detection checks that:
  - a request at the limits is accepted (200) and its rows are counted in the stream stats
  - a request over a limit, including one that only fails on a late event, gets a 400
    naming the limit, the stream's event count does not change, and a sentinel field of an
    earlier, valid event of that request does not show up in the stream schema.
Events without arrays are a row each, so a batch of more flat events than the rows per
request is rejected too (OTEL counts the records with a JSON object body).
Over-limit bytes include those of the structurally flattened rows, whose field names repeat
the names of their parents (`{"<long parent>": {"f0": 0, ...}}` becomes
`{"<long parent>_f0": 0, ...}`), even when the generic rows are small.

The row-per-event and byte caps are set through the environment. The row-per-request cap is
set to 999 in the environment and to 6 on the command line, so every request-rows check
below also proves that the flag takes precedence.

Python 3 standard library only. Build the server first, e.g.
    P_BUILD_NO_UI=1 cargo build --bin parseable
    python3 tools/flatten-bench/http_smoke.py target/debug/parseable
Exit status 0 when every check passed.
"""

import argparse
import base64
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROWS_PER_EVENT = 4
ROWS_PER_REQUEST = 6
BYTES_PER_REQUEST = 4096
# Set in the environment and overridden by the command line flag
ROWS_PER_REQUEST_ENV = 999
AUTH = "Basic " + base64.b64encode(b"admin:admin").decode()

EVENT_MSG = f"more than {ROWS_PER_EVENT} rows (P_MAX_FLATTEN_ROWS_PER_EVENT)"
REQUEST_MSG = f"more than {ROWS_PER_REQUEST} rows (P_MAX_FLATTEN_ROWS_PER_REQUEST)"
BYTES_MSG = f"more than {BYTES_PER_REQUEST} bytes of JSON (P_MAX_FLATTEN_BYTES_PER_REQUEST)"


class Server:
    def __init__(self, base):
        self.base = base

    def request(self, method, path, body=None, headers=None):
        data = None
        all_headers = {"Authorization": AUTH, **(headers or {})}
        if body is not None:
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            all_headers.setdefault("Content-Type", "application/json")
        req = urllib.request.Request(self.base + path, data, all_headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status, resp.read().decode(errors="replace")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode(errors="replace")

    def schema(self, stream):
        """Schema of the stream as text, empty when it does not exist yet"""
        status, text = self.request("GET", f"/api/v1/logstream/{stream}/schema")
        if status == 404:
            return ""
        if status != 200:
            raise AssertionError(f"schema of {stream}: {status} {text}")
        return text

    def events(self, stream):
        status, text = self.request("GET", f"/api/v1/logstream/{stream}/stats")
        if status == 404:
            return 0
        if status != 200:
            raise AssertionError(f"stats of {stream}: {status} {text}")
        return json.loads(text)["ingestion"]["count"]


def free_ports(count):
    """`count` distinct ports that were free on 127.0.0.1 a moment ago"""
    sockets = [socket.socket() for _ in range(count)]
    try:
        for s in sockets:
            s.bind(("127.0.0.1", 0))
        return [s.getsockname()[1] for s in sockets]
    finally:
        for s in sockets:
            s.close()


def start(binary, workdir, startup_timeout):
    # The gRPC, Arrow Flight and query gRPC servers default to fixed ports (8001-8003),
    # which another local server may hold
    port, grpc_port, flight_port, query_grpc_port = free_ports(4)
    for name in ("data", "staging"):
        os.makedirs(os.path.join(workdir, name))
    # Nothing from the caller's P_* settings, so the caps below are the ones in effect
    env = {k: v for k, v in os.environ.items() if not k.startswith("P_")}
    env.update(
        P_ADDR=f"127.0.0.1:{port}",
        P_GRPC_PORT=str(grpc_port),
        P_FLIGHT_PORT=str(flight_port),
        P_QUERY_GRPC_PORT=str(query_grpc_port),
        P_USERNAME="admin",
        P_PASSWORD="admin",
        P_FS_DIR=os.path.join(workdir, "data"),
        P_STAGING_DIR=os.path.join(workdir, "staging"),
        P_CHECK_UPDATE="false",
        P_SEND_ANONYMOUS_USAGE_DATA="false",
        P_RESOURCE_CHECK_ENABLED="false",
        P_MAX_FLATTEN_ROWS_PER_EVENT=str(ROWS_PER_EVENT),
        P_MAX_FLATTEN_ROWS_PER_REQUEST=str(ROWS_PER_REQUEST_ENV),
        P_MAX_FLATTEN_BYTES_PER_REQUEST=str(BYTES_PER_REQUEST),
        RUST_LOG=env.get("RUST_LOG", "warn"),
    )
    log = open(os.path.join(workdir, "server.log"), "wb")
    proc = subprocess.Popen(
        [
            os.path.abspath(binary),
            "local-store",
            "--max-flatten-rows-per-request",
            str(ROWS_PER_REQUEST),
        ],
        cwd=workdir,
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    server = Server(f"http://127.0.0.1:{port}")
    deadline = time.monotonic() + startup_timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            break
        try:
            if server.request("GET", "/api/v1/liveness")[0] == 200:
                return proc, log, server
        except OSError:
            pass
        time.sleep(0.25)
    stop(proc, log)
    raise RuntimeError(f"server did not start (exit code {proc.returncode})")


def stop(proc, log):
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
    log.close()


class Checks:
    def __init__(self, server):
        self.server = server
        self.failures = []

    def check(self, name, ok, detail=""):
        print(f"{'PASS' if ok else 'FAIL'}  {name}{'' if ok else '  ' + detail}")
        if not ok:
            self.failures.append(name)

    def accepted(self, name, stream, rows, method, path, body, headers=None, field=None):
        """`field`: a field of the request that must show up in the schema"""
        before = self.server.events(stream)
        status, text = self.server.request(method, path, body, headers)
        after = self.server.events(stream)
        in_schema = field is None or field in self.server.schema(stream)
        self.check(
            f"{name}: accepted, {rows} events",
            status == 200 and after - before == rows and in_schema,
            f"status {status}, events {before} -> {after}, {field} in schema: {in_schema}, "
            f"body {text[:300]!r}",
        )

    def rejected(
        self, name, stream, message, method, path, body, headers=None, sentinel=None
    ):
        """`sentinel`: a field of an earlier, valid event that must not reach the schema"""
        before = self.server.events(stream) if stream else 0
        status, text = self.server.request(method, path, body, headers)
        after = self.server.events(stream) if stream else 0
        leaked = sentinel is not None and sentinel in self.server.schema(stream)
        self.check(
            f"{name}: 400, no events",
            status == 400 and message in text and after == before and not leaked,
            f"status {status}, events {before} -> {after}, {sentinel} in schema: {leaked}, "
            f"body {text[:300]!r}",
        )


def unique(prefix):
    return f"{prefix}{uuid.uuid4().hex[:10]}"


def arr(n):
    return list(range(n))


def compact_len(value):
    return len(json.dumps(value, separators=(",", ":")))


def flat(n, sentinel=None):
    """`n` events without arrays, a row each. The first one holds `sentinel` when given"""
    events = [{"f": i} for i in range(n)]
    if sentinel is not None:
        events[0][sentinel] = 1
    return events


# Three 1-row events of ~1.5 KiB each: two fit in BYTES_PER_REQUEST, three do not
BIG = "x" * 1500
assert 2 * compact_len({"s": BIG}) < BYTES_PER_REQUEST < 3 * compact_len({"s": BIG})


# 32 small fields below a parent. Structural flattening names every one of them after the
# parent, `{parent}_f0` and so on
FIELDS = {f"f{i}": i for i in range(32)}
LONG_PARENT, MID_PARENT = "p" * 128, "q" * 64


def parent_event(parent, repeated=False, **extra):
    """32 fields below `parent`, in 4 rows when `repeated`"""
    event = {parent: dict(FIELDS)}
    if repeated:
        event["r"] = arr(4)
    event.update(extra)
    return event


def generic_rows(event):
    """Generic rows of an event whose only arrays are top level arrays of scalars"""
    rows = [{}]
    for key, value in event.items():
        alternatives = value if isinstance(value, list) else [value]
        rows = [{**row, key: alt} for alt in alternatives for row in rows]
    return rows


def structural(row, parent=None):
    """`row` with nested objects flattened into fields joined with `_`"""
    out = {}
    for key, value in row.items():
        name = key if parent is None else f"{parent}_{key}"
        if isinstance(value, dict):
            out.update(structural(value, name))
        else:
            out[name] = value
    return out


def rows_len(rows):
    return sum(compact_len(row) for row in rows)


def structural_len(event):
    return rows_len([structural(row) for row in generic_rows(event)])


# The generic rows of the long parent fit in the byte limit, the structurally flattened ones
# do not. One mid-parent event fits, two do not, though their generic rows would.
_long = parent_event(LONG_PARENT, True)
assert len(generic_rows(_long)) == ROWS_PER_EVENT
assert rows_len(generic_rows(_long)) < BYTES_PER_REQUEST < structural_len(_long)
_short = parent_event("p", True)
assert max(rows_len(generic_rows(_short)), structural_len(_short)) < BYTES_PER_REQUEST
_mid = parent_event(MID_PARENT)
assert 2 * rows_len(generic_rows(_mid)) < BYTES_PER_REQUEST
assert structural_len(_mid) < BYTES_PER_REQUEST < 2 * structural_len(_mid)
# A parent of quotes, escaped in every field name: one small generic row, over the byte
# limit only once structurally flattened
ESCAPED_PARENT = '"' * 64
_escaped = parent_event(ESCAPED_PARENT)
assert len(generic_rows(_escaped)) == 1
assert rows_len(generic_rows(_escaped)) < BYTES_PER_REQUEST < structural_len(_escaped)


def structural_checks(c, label, s, post, h, sentinel, wrap=lambda event: event):
    """Long parent names, which only structural flattening repeats, on one ingestion path.
    `wrap` turns a list of events into a request body"""
    c.accepted(
        f"{label} short parent", s, 4, *post, wrap([parent_event("p", True)]), h, "p_f31"
    )
    c.rejected(
        f"{label} long parent copied into every field",
        s,
        BYTES_MSG,
        *post,
        wrap([parent_event(LONG_PARENT, True)]),
        h,
    )
    c.rejected(
        f"{label} escaped parent copied into every field",
        s,
        BYTES_MSG,
        *post,
        wrap([parent_event(ESCAPED_PARENT)]),
        h,
    )
    c.accepted(
        f"{label} parent under byte limit", s, 1, *post, wrap([parent_event(MID_PARENT)]), h
    )
    c.rejected(
        f"{label} parent bytes, late event",
        s,
        BYTES_MSG,
        *post,
        wrap([parent_event(MID_PARENT, **{sentinel: 1}), parent_event(MID_PARENT)]),
        h,
        sentinel,
    )


def run_logstream_route(c):
    # The same JSON ingestion, on the route of an existing stream
    s = unique("flatroute")
    status, text = c.server.request("PUT", f"/api/v1/logstream/{s}")
    c.check("logstream route stream created", status == 200, f"{status} {text[:300]!r}")
    post = ("POST", f"/api/v1/logstream/{s}")
    control, sentinel = unique("control"), unique("sentinel")
    c.accepted(
        "logstream route event at row limit",
        s,
        4,
        *post,
        {"a": arr(4), control: 1},
        None,
        control,
    )
    c.rejected("logstream route event over row limit", s, EVENT_MSG, *post, {"a": arr(5)})
    c.rejected(
        "logstream route request rows, late event",
        s,
        REQUEST_MSG,
        *post,
        [{"a": arr(3), sentinel: 1}, {"a": 1}, {"a": 1}, {"b": arr(2)}],
        None,
        sentinel,
    )
    c.rejected(
        "logstream route request bytes, late event",
        s,
        BYTES_MSG,
        *post,
        [{"s": BIG, sentinel: 1}, {"s": BIG}, {"s": BIG}],
        None,
        sentinel,
    )
    structural_checks(c, "logstream route", s, post, None, unique("sentinel"))


def run_json(c):
    s = unique("flatjson")
    h = {"X-P-Stream": s}
    post = ("POST", "/api/v1/ingest")
    control, sentinel = unique("control"), unique("sentinel")
    c.accepted("json event at row limit", s, 4, *post, {"a": arr(4), control: 1}, h, control)
    c.accepted("json request at row limit", s, 6, *post, [{"a": arr(2)}, {"b": arr(4)}], h)
    flat_sentinel = unique("sentinel")
    c.accepted("json flat batch at request row limit", s, 6, *post, flat(6), h)
    c.rejected(
        "json flat batch over request row limit",
        s,
        REQUEST_MSG,
        *post,
        flat(7, flat_sentinel),
        h,
        flat_sentinel,
    )
    c.rejected("json event over row limit", s, EVENT_MSG, *post, {"a": arr(5)}, h)
    c.rejected(
        "json sibling array product", s, EVENT_MSG, *post, {"a": arr(2), "b": arr(3)}, h
    )
    c.rejected(
        "json nested array product", s, EVENT_MSG, *post, {"a": [{"b": arr(3)}, {"c": arr(2)}]}, h
    )
    c.rejected(
        "json request rows, late event",
        s,
        REQUEST_MSG,
        *post,
        [{"a": arr(3), sentinel: 1}, {"a": 1}, {"a": 1}, {"b": arr(2)}],
        h,
        sentinel,
    )
    c.accepted("json request under byte limit", s, 2, *post, [{"s": BIG}, {"s": BIG}], h)
    c.rejected(
        "json request bytes, late event",
        s,
        BYTES_MSG,
        *post,
        [{"s": BIG, sentinel: 1}, {"s": BIG}, {"s": BIG}],
        h,
        sentinel,
    )
    # Escapes count: 700 quotes serialize to 1400 bytes
    c.rejected(
        "json request bytes with escapes", s, BYTES_MSG, *post, [{"s": '"' * 700}] * 3, h
    )
    structural_checks(c, "json", s, post, h, unique("sentinel"))


def run_partitioned(c):
    s = unique("flatpart")
    status, text = c.server.request(
        "PUT", f"/api/v1/logstream/{s}", headers={"X-P-Custom-Partition": "tenant"}
    )
    c.check("partitioned stream created", status == 200, f"{status} {text[:300]!r}")
    h = {"X-P-Stream": s}
    post = ("POST", "/api/v1/ingest")
    sentinel = unique("sentinel")
    ev = lambda t: {"tenant": t, "x": arr(3)}
    c.accepted("partitioned request at row limit", s, 6, *post, [ev("a"), ev("b")], h)
    # Every partitioned event is flattened on its own, the earlier ones before the last one
    # goes over the limit, and still none of them is written
    flat_part = lambda events: [{"tenant": f"t{i}", **e} for i, e in enumerate(events)]
    flat_sentinel = unique("sentinel")
    c.accepted("partitioned flat batch at request row limit", s, 6, *post, flat_part(flat(6)), h)
    c.rejected(
        "partitioned flat batch over request row limit",
        s,
        REQUEST_MSG,
        *post,
        flat_part(flat(7, flat_sentinel)),
        h,
        flat_sentinel,
    )
    c.rejected(
        "partitioned request rows, late partition",
        s,
        REQUEST_MSG,
        *post,
        [{**ev("a"), sentinel: 1}, ev("b"), ev("c")],
        h,
        sentinel,
    )
    big = lambda t: {"tenant": t, "s": BIG}
    c.accepted("partitioned request under byte limit", s, 2, *post, [big("a"), big("b")], h)
    c.rejected(
        "partitioned request bytes, late partition",
        s,
        BYTES_MSG,
        *post,
        [{**big("a"), sentinel: 1}, big("b"), big("c")],
        h,
        sentinel,
    )
    c.rejected(
        "partitioned event over row limit", s, EVENT_MSG, *post, [{"tenant": "a", "x": arr(5)}], h
    )
    structural_checks(
        c,
        "partitioned",
        s,
        post,
        h,
        unique("sentinel"),
        lambda events: [{"tenant": f"t{i}", **event} for i, event in enumerate(events)],
    )


def run_known_format(c):
    # `block_log` events that already hold its fields (`body`, `timestamp`) are accepted as
    # they are, and then flattened like plain JSON
    s = unique("flatformat")
    h = {"X-P-Stream": s, "X-P-Log-Source": "block_log"}
    post = ("POST", "/api/v1/ingest")
    sentinel = unique("sentinel")
    ev = lambda n: {"body": "line", "timestamp": "2024-01-11T09:08:34.290Z", "a": arr(n)}
    c.accepted("known format event at row limit", s, 4, *post, ev(4), h)
    c.rejected("known format event over row limit", s, EVENT_MSG, *post, ev(5), h)
    c.rejected(
        "known format request rows, late event",
        s,
        REQUEST_MSG,
        *post,
        [{**ev(3), sentinel: 1}, ev(1), ev(3)],
        h,
        sentinel,
    )


def kinesis(records, request_id="req"):
    return {
        "requestId": request_id,
        "timestamp": 1704964113659,
        "records": [
            {"data": base64.b64encode(json.dumps(r).encode()).decode()} for r in records
        ],
    }


def run_kinesis(c):
    s = unique("flatkinesis")
    sentinel = unique("sentinel")
    h = {"X-P-Stream": s, "X-P-Log-Source": "kinesis"}
    post = ("POST", "/api/v1/ingest")
    c.accepted("kinesis request at row limit", s, 6, *post, kinesis([{"a": arr(3)}] * 2), h)
    flat_sentinel = unique("sentinel")
    c.accepted("kinesis flat records at request row limit", s, 6, *post, kinesis(flat(6)), h)
    c.rejected(
        "kinesis flat records over request row limit",
        s,
        REQUEST_MSG,
        *post,
        kinesis(flat(7, flat_sentinel)),
        h,
        flat_sentinel,
    )
    # A decoded array is one event
    c.rejected(
        "kinesis decoded array over event limit",
        s,
        EVENT_MSG,
        *post,
        kinesis([[{"a": arr(3)}, {"b": arr(2)}]]),
        h,
    )
    c.rejected(
        "kinesis request rows, late record",
        s,
        REQUEST_MSG,
        *post,
        kinesis([{"a": arr(3), sentinel: 1}, {"a": arr(3)}, {"a": arr(3)}]),
        h,
        sentinel,
    )
    # The rows are tiny, the 1000 byte requestId copied into each of them is not
    long_id = "r" * 1000
    c.accepted(
        "kinesis long requestId under byte limit", s, 3, *post, kinesis([{"a": arr(3)}], long_id), h
    )
    c.rejected(
        "kinesis requestId bytes, late record",
        s,
        BYTES_MSG,
        *post,
        kinesis([{"a": arr(3), sentinel: 1}, {"a": arr(3)}], long_id),
        h,
        sentinel,
    )
    # Each record is one event, and its metadata fields take ~50 bytes per row
    structural_checks(c, "kinesis", s, post, h, unique("sentinel"), kinesis)


def otel_body(body):
    """A string body, or a dict of key -> string for a key-value list body"""
    if isinstance(body, str):
        return {"stringValue": body}
    values = [{"key": k, "value": {"stringValue": v}} for k, v in body.items()]
    return {"kvlistValue": {"values": values}}


def otel(resources):
    """resources: list of resources, each a list of scopes, each a list of bodies"""
    now = str(time.time_ns())
    return {
        "resourceLogs": [
            {
                "scopeLogs": [
                    {
                        "logRecords": [
                            {
                                "timeUnixNano": now,
                                "severityNumber": 9,
                                "body": otel_body(body),
                            }
                            for body in scope
                        ]
                    }
                    for scope in resource
                ]
            }
            for resource in resources
        ]
    }


def run_otel(c):
    s = unique("flatotel")
    h = {"X-P-Stream": s}
    post = ("POST", "/v1/logs")
    three = json.dumps({"a": arr(3)})
    control, sentinel = unique("control"), unique("sentinel")
    # A record is one event; each of these bodies flattens to 3 rows merged into 1 record
    c.accepted(
        "otel request at row limit",
        s,
        2,
        *post,
        otel([[[{"b": json.dumps({"a": arr(3), control: 1})}], [three]]]),
        h,
        control,
    )
    c.rejected(
        "otel body over event limit", s, EVENT_MSG, *post, otel([[[json.dumps({"a": arr(5)})]]]), h
    )
    c.rejected(
        "otel request rows, late resource",
        s,
        REQUEST_MSG,
        *post,
        otel([[[json.dumps({"a": arr(3), sentinel: 1})], [three]], [[three]]]),
        h,
        sentinel,
    )
    c.accepted("otel body that is not JSON", s, 1, *post, otel([[["plain text"]]]), h)
    # A record whose body is a JSON object without arrays is a row; one whose body is not
    # JSON is none
    flat_sentinel = unique("sentinel")
    flat_bodies = lambda events: [json.dumps(event) for event in events]
    c.accepted(
        "otel flat JSON bodies at request row limit", s, 6, *post, otel([[flat_bodies(flat(6))]]), h
    )
    c.rejected(
        "otel flat JSON bodies over request row limit",
        s,
        REQUEST_MSG,
        *post,
        otel([[flat_bodies(flat(7, flat_sentinel))]]),
        h,
        flat_sentinel,
    )
    c.accepted(
        "otel bodies that are not JSON over request row limit",
        s,
        7,
        *post,
        otel([[["plain text"] * 7]]),
        h,
    )

    # A single row of 32 small fields. Every field is renamed to `{key}_{field}` when it is
    # merged into the record, so a long key costs 32 times its length
    wide = json.dumps({f"f{i}": i for i in range(32)})
    prefixed = lambda key, body: compact_len({f"{key}_{f}": v for f, v in json.loads(body).items()})
    long_key, mid_key = "k" * 128, "m" * 64
    assert prefixed("k", wide) < BYTES_PER_REQUEST < 32 * (len(long_key) + 1)
    assert prefixed(mid_key, wide) < BYTES_PER_REQUEST < 2 * prefixed(mid_key, wide)
    c.accepted("otel short body key", s, 1, *post, otel([[[{"k": wide}]]]), h, "k_f31")
    c.rejected(
        "otel long body key copied into every field",
        s,
        BYTES_MSG,
        *post,
        otel([[[{long_key: wide}]]]),
        h,
    )
    c.accepted("otel body key under byte limit", s, 1, *post, otel([[[{mid_key: wide}]]]), h)
    c.rejected(
        "otel body key bytes, late resource",
        s,
        BYTES_MSG,
        *post,
        otel([[[{mid_key: wide, "s": json.dumps({sentinel: 1})}]], [[{mid_key: wide}]]]),
        h,
        sentinel,
    )

    # Bodies with a parent object: structurally flattening the record repeats the body key
    # and the parent in the name of every field below it, `{key}_{parent}_{field}`
    nested = lambda parent, repeated=False, **extra: json.dumps(
        parent_event(parent, repeated, **extra)
    )
    c.accepted(
        "otel nested body", s, 1, *post, otel([[[nested("p", True)]]]), h, "body_p_f31"
    )
    c.rejected(
        "otel nested body, long parent",
        s,
        BYTES_MSG,
        *post,
        otel([[[nested(LONG_PARENT, True)]]]),
        h,
    )
    # With a long key copied into each of the 32 nested fields; generic rows and the key
    # copied into the root field alone are ~400 bytes
    nested_key = lambda key: structural_len({key: parent_event("p")})
    assert compact_len({f"{long_key}_p": FIELDS}) < BYTES_PER_REQUEST < nested_key(long_key)
    c.rejected(
        "otel long body key copied into nested fields",
        s,
        BYTES_MSG,
        *post,
        otel([[[{long_key: nested("p")}]]]),
        h,
    )
    c.rejected(
        "otel nested body bytes, late resource",
        s,
        BYTES_MSG,
        *post,
        otel([[[nested(MID_PARENT, **{sentinel: 1})]], [[nested(MID_PARENT)]]]),
        h,
        sentinel,
    )


def run_schema_detect(c):
    path = ("POST", "/api/v1/logstream/schema/detect")
    status, text = c.server.request(*path, [{"a": arr(2)}, {"b": arr(4)}])
    c.check("schema detect at row limit: 200", status == 200, f"{status} {text[:300]!r}")
    c.rejected("schema detect event over row limit", None, EVENT_MSG, *path, {"a": arr(5)})
    c.rejected(
        "schema detect request rows", None, REQUEST_MSG, *path, [{"a": arr(4)}, {"b": arr(3)}]
    )
    c.rejected(
        "schema detect request bytes", None, BYTES_MSG, *path, [{"s": BIG}, {"s": BIG}, {"s": BIG}]
    )
    status, text = c.server.request(*path, parent_event("p", True))
    c.check(
        "schema detect short parent: 200",
        status == 200 and "p_f31" in text,
        f"{status} {text[:300]!r}",
    )
    c.rejected(
        "schema detect long parent copied into every field",
        None,
        BYTES_MSG,
        *path,
        parent_event(LONG_PARENT, True),
    )
    c.rejected(
        "schema detect parent bytes, late event",
        None,
        BYTES_MSG,
        *path,
        [parent_event(MID_PARENT), parent_event(MID_PARENT)],
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("binary", help="path to the parseable server binary")
    parser.add_argument("--startup-timeout", type=float, default=120, help="seconds")
    parser.add_argument("--keep", action="store_true", help="keep the temporary directory")
    args = parser.parse_args()

    workdir = tempfile.mkdtemp(prefix="parseable-flatten-smoke-")
    proc = log = None
    ok = False
    try:
        proc, log, server = start(args.binary, workdir, args.startup_timeout)
        c = Checks(server)
        runs = (
            run_json,
            run_logstream_route,
            run_known_format,
            run_partitioned,
            run_kinesis,
            run_otel,
        )
        for run in runs + (run_schema_detect,):
            run(c)
        ok = not c.failures
        print(f"\n{'all checks passed' if ok else f'{len(c.failures)} check(s) failed'}")
    finally:
        if proc is not None:
            stop(proc, log)
        if not ok:
            log_path = os.path.join(workdir, "server.log")
            if os.path.exists(log_path):
                with open(log_path, errors="replace") as f:
                    print("--- server.log (tail) ---\n" + "".join(f.readlines()[-40:]))
        if args.keep or not ok:
            print(f"kept {workdir}")
        else:
            import shutil

            shutil.rmtree(workdir, ignore_errors=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
