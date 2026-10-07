#!/usr/bin/env python3
"""Isolated end-to-end OIDC role reconciliation smoke test.

Starts a disposable Parseable local-store process and an in-process mock OIDC
issuer. It never reads the caller's Parseable/OIDC environment or data paths.
OpenSSL is used only to create a temporary test signing key and sign test ID
tokens. No tokens, passwords, or private key material are printed.
"""

from __future__ import annotations

import base64
import hashlib
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


CLIENT_ID = "parseable-oidc-smoke-client"
CLIENT_SECRET = "parseable-oidc-smoke-secret"
SUBJECT = "oidc-smoke-user"
GROUP_SOURCE_ONLY = "parseable-oidc-smoke-readers"
GROUP_SHARED = "parseable-oidc-smoke-shared"
ROLE_MANUAL = "parseable-oidc-smoke-manual"
ROLE_DEFAULT = "parseable-oidc-smoke-default"
STREAM_NAME = "parseable_oidc_smoke_fixture"
ISSUER_PATH = "/oidc-smoke"
WAIT_SECONDS = 35


def fail(message: str) -> None:
    raise RuntimeError(message)


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def parse_der_tlv(data: bytes, offset: int = 0) -> tuple[int, bytes, int]:
    tag = data[offset]
    offset += 1
    size = data[offset]
    offset += 1
    if size & 0x80:
        count = size & 0x7F
        size = int.from_bytes(data[offset : offset + count], "big")
        offset += count
    end = offset + size
    return tag, data[offset:end], end


def rsa_jwk_from_public_der(der: bytes) -> tuple[str, str]:
    _, outer, _ = parse_der_tlv(der)
    _, _algorithm, cursor = parse_der_tlv(outer)
    _, bit_string, _ = parse_der_tlv(outer, cursor)
    _, rsa_sequence, _ = parse_der_tlv(bit_string, 1)  # first bit is unused-bit count
    _, modulus, cursor = parse_der_tlv(rsa_sequence)
    _, exponent, _ = parse_der_tlv(rsa_sequence, cursor)
    return b64url(modulus.lstrip(b"\x00")), b64url(exponent.lstrip(b"\x00"))


class MockIssuer:
    def __init__(self, root: Path):
        self.root = root
        self.key_path = root / "test-signing-key.pem"
        self.public_path = root / "test-signing-public.der"
        subprocess.run(
            ["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", str(self.key_path)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        subprocess.run(
            ["openssl", "pkey", "-in", str(self.key_path), "-pubout", "-outform", "DER", "-out", str(self.public_path)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.modulus, self.exponent = rsa_jwk_from_public_der(self.public_path.read_bytes())
        self.groups = {GROUP_SOURCE_ONLY, GROUP_SHARED}
        self.subject = SUBJECT
        self.token_expiry = 5
        self.omit_groups_claim = False
        self.omit_refresh_id_token = False
        self.codes: dict[str, dict[str, str]] = {}
        self.access_tokens = {"smoke-access-token"}
        self.current_refresh_token = "smoke-refresh-token-0"
        self.refresh_tokens = {self.current_refresh_token}
        self.refresh_count = 0
        self.token_request_count = 0
        self.token_request_rejection: str | None = None
        self.userinfo_request_count = 0
        self.block_next_refresh = False
        self.fail_next_refresh_transiently = False
        self.refresh_entered = threading.Event()
        self.release_refresh = threading.Event()
        self.server: http.server.ThreadingHTTPServer | None = None
        self.thread: threading.Thread | None = None

    def start(self) -> str:
        issuer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, _format: str, *_args: object) -> None:
                return

            def send_json(self, value: object, status: int = 200) -> None:
                body = json.dumps(value, separators=(",", ":")).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
                parsed = urllib.parse.urlsplit(self.path)
                if parsed.path == f"{ISSUER_PATH}/.well-known/openid-configuration":
                    issuer_url = issuer.issuer_url
                    self.send_json(
                        {
                            "issuer": issuer_url,
                            "authorization_endpoint": f"{issuer_url}/authorize",
                            "token_endpoint": f"{issuer_url}/token",
                            "userinfo_endpoint": f"{issuer_url}/userinfo",
                            "jwks_uri": f"{issuer_url}/jwks",
                            "response_types_supported": ["code"],
                            "subject_types_supported": ["public"],
                            "id_token_signing_alg_values_supported": ["RS256"],
                            "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"],
                            "scopes_supported": ["openid", "profile", "email", "groups"],
                        }
                    )
                elif parsed.path == f"{ISSUER_PATH}/jwks":
                    self.send_json(
                        {
                            "keys": [
                                {
                                    "kty": "RSA",
                                    "use": "sig",
                                    "alg": "RS256",
                                    "kid": "oidc-smoke-key-1",
                                    "n": issuer.modulus,
                                    "e": issuer.exponent,
                                }
                            ]
                        }
                    )
                elif parsed.path == f"{ISSUER_PATH}/authorize":
                    query = urllib.parse.parse_qs(parsed.query)
                    if query.get("client_id") != [CLIENT_ID] or "groups" not in query.get("scope", [""])[0].split():
                        self.send_error(400)
                        return
                    code = uuid.uuid4().hex
                    redirect_uri = query.get("redirect_uri", [""])[0]
                    state = query.get("state", [""])[0]
                    issuer.codes[code] = {"redirect_uri": redirect_uri, "state": state}
                    location = f"{redirect_uri}?{urllib.parse.urlencode({'code': code, 'state': state})}"
                    self.send_response(302)
                    self.send_header("Location", location)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                elif parsed.path == f"{ISSUER_PATH}/userinfo":
                    issuer.userinfo_request_count += 1
                    if self.headers.get("Authorization") not in {
                        f"Bearer {token}" for token in issuer.access_tokens
                    }:
                        self.send_json({"error": "invalid_token"}, 401)
                        return
                    self.send_json(
                        {
                            "sub": issuer.subject,
                            "email": f"{issuer.subject}@example.invalid",
                            "name": "OIDC Smoke User",
                            "preferred_username": issuer.subject,
                            "groups": sorted(issuer.groups),
                        }
                    )
                else:
                    self.send_error(404)

            def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
                parsed = urllib.parse.urlsplit(self.path)
                length = int(self.headers.get("Content-Length", "0"))
                form = urllib.parse.parse_qs(self.rfile.read(length).decode())
                if parsed.path != f"{ISSUER_PATH}/token":
                    self.send_error(404)
                    return
                issuer.token_request_count += 1
                authorization = self.headers.get("Authorization", "")
                basic_ok = False
                if authorization.startswith("Basic "):
                    try:
                        user, secret = base64.b64decode(authorization[6:]).decode().split(":", 1)
                        basic_ok = user == CLIENT_ID and secret == CLIENT_SECRET
                    except (ValueError, UnicodeDecodeError):
                        pass
                post_ok = form.get("client_id") == [CLIENT_ID] and form.get("client_secret") == [CLIENT_SECRET]
                if not (basic_ok or post_ok):
                    issuer.token_request_rejection = "invalid client authentication"
                    self.send_json({"error": "invalid_client"}, 401)
                    return
                grant = form.get("grant_type", [""])[0]
                if grant == "authorization_code":
                    code = form.get("code", [""])[0]
                    record = issuer.codes.pop(code, None)
                    if not record or form.get("redirect_uri") != [record["redirect_uri"]]:
                        issuer.token_request_rejection = "invalid code or redirect URI"
                        self.send_json({"error": "invalid_grant"}, 400)
                        return
                    self.send_json(issuer.token_payload(include_refresh=True))
                elif grant == "refresh_token":
                    token = form.get("refresh_token", [""])[0]
                    if token not in issuer.refresh_tokens:
                        issuer.token_request_rejection = "invalid refresh token"
                        self.send_json({"error": "invalid_grant"}, 400)
                        return
                    if issuer.fail_next_refresh_transiently:
                        issuer.fail_next_refresh_transiently = False
                        self.send_json({"error": "temporarily_unavailable"}, 503)
                        return
                    if issuer.block_next_refresh:
                        issuer.block_next_refresh = False
                        issuer.refresh_entered.set()
                        if not issuer.release_refresh.wait(timeout=15):
                            self.send_json({"error": "temporarily_unavailable"}, 503)
                            return
                    issuer.refresh_tokens.remove(token)
                    issuer.refresh_count += 1
                    issuer.current_refresh_token = f"smoke-refresh-token-{issuer.refresh_count}"
                    issuer.refresh_tokens.add(issuer.current_refresh_token)
                    self.send_json(issuer.token_payload(include_refresh=True, refresh=True))
                else:
                    self.send_json({"error": "unsupported_grant_type"}, 400)

            def do_HEAD(self) -> None:  # noqa: N802
                self.send_error(404)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        host, port = self.server.server_address
        self.issuer_url = f"http://{host}:{port}{ISSUER_PATH}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self.issuer_url

    def token_payload(self, *, include_refresh: bool, refresh: bool = False) -> dict[str, object]:
        now = int(time.time())
        claims = {
            "iss": self.issuer_url,
            "aud": CLIENT_ID,
            "sub": self.subject,
            "iat": now,
            "exp": now + 60,
            "email": f"{self.subject}@example.invalid",
            "name": "OIDC Smoke User",
        }
        if not self.omit_groups_claim:
            claims["groups"] = sorted(self.groups)
        header = {"alg": "RS256", "typ": "JWT", "kid": "oidc-smoke-key-1"}
        signing_input = f"{b64url(json.dumps(header, separators=(',', ':')).encode())}.{b64url(json.dumps(claims, separators=(',', ':')).encode())}".encode()
        signature = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", str(self.key_path)],
            input=signing_input,
            check=True,
            capture_output=True,
        ).stdout
        payload: dict[str, object] = {
            "access_token": "smoke-access-token",
            "token_type": "Bearer",
            "expires_in": self.token_expiry,
        }
        if not (self.omit_refresh_id_token and refresh):
            payload["id_token"] = f"{signing_input.decode()}.{b64url(signature)}"
        if include_refresh:
            payload["refresh_token"] = self.current_refresh_token
        return payload

    def stop(self) -> None:
        if self.server:
            self.server.shutdown()
            self.server.server_close()
        if self.thread:
            self.thread.join(timeout=2)


class Smoke:
    def __init__(self, base_url: str, username: str, password: str):
        self.base_url = base_url.rstrip("/")
        token = base64.b64encode(f"{username}:{password}".encode()).decode()
        self.auth_header = f"Basic {token}"

    def request(self, path: str, *, method: str = "GET", body: object | None = None, headers: dict[str, str] | None = None, follow: bool = True, admin_auth: bool = True) -> tuple[int, bytes, dict[str, str]]:
        request_headers = {"Accept": "application/json"}
        if admin_auth:
            request_headers["Authorization"] = self.auth_header
        if headers:
            request_headers.update(headers)
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            request_headers["Content-Type"] = "application/json"
        req = urllib.request.Request(f"{self.base_url}{path}", data=data, headers=request_headers, method=method)
        opener = urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect())
        try:
            with opener.open(req, timeout=10) as response:
                return response.status, response.read(), dict(response.headers.items())
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(), dict(exc.headers.items())

    def admin(self, path: str, *, method: str = "GET", body: object | None = None) -> tuple[int, object, dict[str, str]]:
        status, raw, headers = self.request(path, method=method, body=body)
        try:
            payload: object = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            payload = raw.decode(errors="replace")
        return status, payload, headers

    def create_role(self, name: str, actions: list[object] | None = None) -> None:
        status, _payload, _headers = self.admin(
            f"/api/v1/role/{urllib.parse.quote(name, safe='')}",
            method="PUT",
            body={"actions": actions or [], "roleType": "user"},
        )
        if status not in (200, 201, 204):
            fail(f"creating smoke role failed (HTTP {status})")

    def user_roles(self, user_id: str) -> set[str]:
        status, payload, _headers = self.admin(f"/api/v1/user/{urllib.parse.quote(user_id, safe='')}/role")
        if status != 200 or not isinstance(payload, dict):
            fail(f"cannot inspect smoke user roles (HTTP {status})")
        roles = payload.get("roles", {})
        if not isinstance(roles, dict):
            fail("role API returned an unexpected shape")
        return set(roles)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def get_free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def get_cli_binary() -> Path:
    value = os.environ.get("PARSEABLE_BIN")
    if not value:
        fail("set PARSEABLE_BIN to the already-built Parseable executable")
    binary = Path(value).expanduser().resolve()
    if not binary.is_file() or not os.access(binary, os.X_OK):
        fail("PARSEABLE_BIN must name an executable file")
    return binary


def wait_for_parseable(smoke: Smoke, process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + WAIT_SECONDS
    while time.monotonic() < deadline:
        if process.poll() is not None:
            fail("disposable Parseable process exited before becoming ready")
        try:
            status, _body, _headers = smoke.request("/api/v1/liveness", follow=False)
            if status == 200:
                return
        except urllib.error.URLError:
            pass
        time.sleep(0.25)
    fail("disposable Parseable process did not become ready in time")


def do_login(smoke: Smoke, issuer: MockIssuer) -> tuple[str, str]:
    redirect = f"{smoke.base_url}/oidc-smoke-finished"
    status, _body, headers = smoke.request(
        f"/api/v1/o/login?{urllib.parse.urlencode({'redirect': redirect})}",
        follow=False,
        admin_auth=False,
    )
    if status not in (302, 307, 303):
        fail(f"OIDC login did not redirect to the provider (HTTP {status})")
    location = headers.get("Location") or headers.get("location")
    if not location:
        fail("OIDC login redirect omitted its Location")
    opener = urllib.request.build_opener(NoRedirect())
    try:
        opener.open(location, timeout=10)
    except urllib.error.HTTPError as exc:
        if exc.code not in (302, 303, 307):
            fail(f"mock OIDC authorization endpoint returned HTTP {exc.code}")
        callback_url = exc.headers.get("Location")
    else:
        fail("mock OIDC authorization did not redirect back to Parseable")
    if not callback_url:
        fail("mock OIDC callback redirect omitted its Location")
    callback = urllib.parse.urlsplit(callback_url)
    if callback.netloc != urllib.parse.urlsplit(smoke.base_url).netloc or callback.path != "/api/v1/o/code":
        fail("OIDC provider returned an unexpected callback URI")
    callback_query = urllib.parse.parse_qs(callback.query)
    if not callback_query.get("state") or not callback_query.get("code"):
        fail("OIDC callback did not include code and state")
    callback_headers = {"Accept": "application/json"}
    req = urllib.request.Request(callback_url, headers=callback_headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            status = response.status
            payload = json.loads(response.read())
            set_cookie = response.headers.get_all("Set-Cookie", [])
    except urllib.error.HTTPError as exc:
        fail(
            f"OIDC callback exchange failed (HTTP {exc.code}); mock token requests={issuer.token_request_count}, "
            f"userinfo requests={issuer.userinfo_request_count}, provider rejection={issuer.token_request_rejection or 'none'}"
        )
    if status != 200 or not payload.get("session"):
        fail("OIDC callback did not create a Parseable session")
    session_cookie = next((x.split(";", 1)[0] for x in set_cookie if x.startswith("session=")), None)
    if not session_cookie:
        fail("OIDC callback omitted the Parseable session cookie")
    user_id = payload.get("user_id")
    if not isinstance(user_id, str) or not user_id:
        fail("OIDC callback omitted the OAuth user id")
    # Don't include any callback values in status output; they are session material.
    return user_id, session_cookie


def test_flow(smoke: Smoke, issuer: MockIssuer) -> None:
    role_source = GROUP_SOURCE_ONLY
    role_shared = GROUP_SHARED
    status, _payload, _headers = smoke.admin(
        f"/api/v1/logstream/{STREAM_NAME}", method="PUT", body={}
    )
    if status != 200:
        fail(f"creating isolated authorization fixture stream failed (HTTP {status})")
    reader_action = {
        "privilege": "reader",
        "resource": {"stream": STREAM_NAME},
    }
    smoke.create_role(role_source, [reader_action])
    for role in (role_shared, ROLE_MANUAL):
        smoke.create_role(role)
    smoke.create_role(ROLE_DEFAULT, [reader_action])

    # Unknown and internal roles must never be accepted as a default.
    status, _payload, _headers = smoke.admin("/api/v1/role/default", method="PUT", body="parseable-oidc-smoke-missing")
    if status < 400:
        fail("setting an unknown default role was accepted")
    status, _payload, _headers = smoke.admin("/api/v1/role/default", method="PUT", body="super-admin")
    if status < 400:
        fail("setting the internal super-admin role as default was accepted")

    # The browser-shaped login flow must carry state and complete a real signed
    # ID-token exchange against the mock issuer's discovery and JWKS endpoints.
    user_id, session_cookie = do_login(smoke, issuer)
    info_path = f"/api/v1/logstream/{STREAM_NAME}/info"
    status, _body, _headers = smoke.request(
        info_path,
        headers={"Cookie": session_cookie},
        follow=False,
        admin_auth=False,
    )
    if status != 200:
        fail(f"provider-mapped Reader role could not access the fixture stream (HTTP {status})")
    observed = smoke.user_roles(user_id)
    if observed != {role_source, role_shared}:
        fail("first login did not assign precisely the mapped provider groups")

    # A manual grant for a role also present in groups must remain manual after
    # the provider removes it; a separate provider-only grant must disappear.
    status, _payload, _headers = smoke.admin(
        f"/api/v1/user/{urllib.parse.quote(user_id, safe='')}/role/add",
        method="PATCH",
        body=[role_shared, ROLE_MANUAL],
    )
    if status not in (200, 201, 204):
        fail("adding manual smoke roles failed")

    # Removing a provider-managed-only role manually must fail clearly.
    status, payload, _headers = smoke.admin(
        f"/api/v1/user/{urllib.parse.quote(user_id, safe='')}/role/remove",
        method="PATCH",
        body=[role_source],
    )
    if status < 400 or not isinstance(payload, str) or not payload.strip():
        fail("manual removal of a provider-only role did not return a clear error")

    # Refresh signs a fresh ID token
    # after the mock provider's membership changes, exercising server-side
    # reconciliation without requiring a second browser login.
    issuer.groups = set()
    issuer.omit_groups_claim = True
    issuer.token_expiry = 1
    time.sleep(5.25)
    barrier = threading.Barrier(2)

    def concurrent_stream_request() -> tuple[int, bytes, dict[str, str]]:
        barrier.wait(timeout=5)
        return smoke.request(
            info_path,
            headers={"Cookie": session_cookie},
            follow=False,
            admin_auth=False,
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _index: concurrent_stream_request(), range(2)))
    if any(status not in (401, 403) for status, _body, _headers in results):
        fail("a request still had stream access after its provider group was removed")
    if issuer.refresh_count != 1:
        fail("concurrent expired-session requests did not share one successful token refresh")

    observed = smoke.user_roles(user_id)
    expected = {role_shared, ROLE_MANUAL}
    if observed != expected:
        fail("refresh reconciliation did not remove provider-only roles while preserving manual grants")

    # No groups or manual grants: the validated default role applies. DELETE
    # must clear it for the next verified login of that same OAuth identity.
    status, _payload, _headers = smoke.admin("/api/v1/role/default", method="PUT", body=ROLE_DEFAULT)
    if status not in (200, 204):
        fail("setting a valid default role failed")
    issuer.groups = set()
    issuer.subject = "oidc-smoke-default-user"
    default_user_id, _default_session = do_login(smoke, issuer)
    if smoke.user_roles(default_user_id) != {ROLE_DEFAULT}:
        fail("OAuth user without other grants did not receive the configured default role")
    status, _body, _headers = smoke.request(
        info_path,
        headers={"Cookie": _default_session},
        follow=False,
        admin_auth=False,
    )
    if status != 200:
        fail("configured default Reader role did not authorize the fixture stream")

    status, _payload, _headers = smoke.admin("/api/v1/role/default", method="DELETE")
    if status not in (200, 204):
        fail("clearing the default role failed")
    status, payload, _headers = smoke.admin("/api/v1/role/default")
    if status != 200 or payload is not None:
        fail("cleared default role remained configured")
    cleared_user_id, _cleared_session = do_login(smoke, issuer)
    if smoke.user_roles(cleared_user_id):
        fail("cleared default role remained on a later OAuth reconciliation")

    # A refreshed session without a new signed ID token cannot carry forward
    # old authorization. It must fail closed and remove the session.
    issuer.subject = "oidc-smoke-no-id-token-user"
    issuer.groups = {GROUP_SOURCE_ONLY}
    issuer.omit_groups_claim = False
    issuer.omit_refresh_id_token = True
    issuer.token_expiry = 5
    missing_token_user, missing_token_cookie = do_login(smoke, issuer)
    if smoke.user_roles(missing_token_user) != {role_source}:
        fail("test user for missing refreshed ID token was not initialized")
    status, _body, _headers = smoke.request(
        info_path,
        headers={"Cookie": missing_token_cookie},
        follow=False,
        admin_auth=False,
    )
    if status != 200:
        fail("provider-mapped test user could not access the fixture stream before refresh")
    issuer.token_expiry = 1
    time.sleep(5.25)
    status, _body, _headers = smoke.request(
        info_path,
        headers={"Cookie": missing_token_cookie},
        follow=False,
        admin_auth=False,
    )
    if status != 401:
        fail(f"refresh without an ID token did not fail closed (HTTP {status})")

    # A transient provider failure fails only the current request. The session
    # survives, and the next request refreshes it with the same refresh token.
    issuer.subject = "oidc-smoke-transient-user"
    issuer.groups = {GROUP_SOURCE_ONLY}
    issuer.omit_refresh_id_token = False
    issuer.token_expiry = 5
    _transient_user, transient_cookie = do_login(smoke, issuer)
    issuer.token_expiry = 1
    time.sleep(5.25)
    issuer.fail_next_refresh_transiently = True
    status, _body, _headers = smoke.request(
        info_path,
        headers={"Cookie": transient_cookie},
        follow=False,
        admin_auth=False,
    )
    if status != 503:
        fail(f"transient provider refresh failure was not reported as unavailable (HTTP {status})")
    status, _body, _headers = smoke.request(
        info_path,
        headers={"Cookie": transient_cookie},
        follow=False,
        admin_auth=False,
    )
    if status != 200:
        fail(f"session did not survive a transient provider refresh failure (HTTP {status})")

    # Logout while the issuer is holding a refresh response. The refresh must
    # not recreate the removed cookie session after the response is released.
    issuer.subject = "oidc-smoke-logout-race-user"
    issuer.groups = {GROUP_SOURCE_ONLY}
    issuer.omit_refresh_id_token = False
    issuer.token_expiry = 5
    logout_user, logout_cookie = do_login(smoke, issuer)
    if smoke.user_roles(logout_user) != {role_source}:
        fail("logout-race user did not receive its provider Reader role")
    status, _body, _headers = smoke.request(
        info_path,
        headers={"Cookie": logout_cookie},
        follow=False,
        admin_auth=False,
    )
    if status != 200:
        fail("logout-race user could not access the fixture stream before refresh")
    issuer.token_expiry = 1
    time.sleep(5.25)
    issuer.refresh_entered.clear()
    issuer.release_refresh.clear()
    issuer.block_next_refresh = True
    refresh_count_before = issuer.refresh_count
    with ThreadPoolExecutor(max_workers=2) as pool:
        in_flight = pool.submit(
            smoke.request,
            info_path,
            headers={"Cookie": logout_cookie},
            follow=False,
            admin_auth=False,
        )
        if not issuer.refresh_entered.wait(timeout=10):
            issuer.release_refresh.set()
            fail("mock provider did not block the logout-race refresh")
        redirect = urllib.parse.quote(f"{smoke.base_url}/oidc-smoke-logged-out", safe="")
        logout = pool.submit(
            smoke.request,
            f"/api/v1/o/logout?redirect={redirect}",
            headers={"Cookie": logout_cookie},
            follow=False,
            admin_auth=False,
        )
        time.sleep(0.3)
        issuer.release_refresh.set()
        in_flight_result = in_flight.result(timeout=15)
        logout_result = logout.result(timeout=15)
    if in_flight_result[0] != 401:
        fail(f"in-flight refresh survived logout (HTTP {in_flight_result[0]})")
    if logout_result[0] != 301:
        fail(f"logout did not complete after the blocked refresh (HTTP {logout_result[0]})")
    if not any(
        name.lower() == "set-cookie" and "Max-Age=0" in value
        for name, value in logout_result[2].items()
    ):
        fail("logout did not clear the browser's session cookies")
    if issuer.refresh_count != refresh_count_before + 1:
        fail("logout-race refresh did not complete exactly once")
    status, _body, _headers = smoke.request(
        info_path,
        headers={"Cookie": logout_cookie},
        follow=False,
        admin_auth=False,
    )
    if status != 401:
        fail(f"logout cookie was recreated after refresh (HTTP {status})")

    # Changing the default must not sign out users whose roles it does not
    # affect, here a user with a provider grant.
    issuer.subject = "oidc-smoke-unaffected-by-default-user"
    issuer.groups = {GROUP_SOURCE_ONLY}
    issuer.token_expiry = 5
    _unaffected_user, unaffected_cookie = do_login(smoke, issuer)

    # Clearing a configured default while refresh is waiting must have the
    # same revocation behavior and must not restore the default grant.
    status, _payload, _headers = smoke.admin(
        "/api/v1/role/default", method="PUT", body=ROLE_DEFAULT
    )
    if status not in (200, 204):
        fail("setting default role for invalidation race failed")
    status, _body, _headers = smoke.request(
        info_path,
        headers={"Cookie": unaffected_cookie},
        follow=False,
        admin_auth=False,
    )
    if status != 200:
        fail(f"changing the default role signed out a user it does not affect (HTTP {status})")
    issuer.subject = "oidc-smoke-default-race-user"
    issuer.groups = set()
    issuer.token_expiry = 5
    default_race_user, default_race_cookie = do_login(smoke, issuer)
    if smoke.user_roles(default_race_user) != {ROLE_DEFAULT}:
        fail("default-race user did not receive its default Reader role")
    status, _body, _headers = smoke.request(
        info_path,
        headers={"Cookie": default_race_cookie},
        follow=False,
        admin_auth=False,
    )
    if status != 200:
        fail("default-race user could not access the fixture stream before refresh")
    issuer.token_expiry = 1
    time.sleep(5.25)
    issuer.refresh_entered.clear()
    issuer.release_refresh.clear()
    issuer.block_next_refresh = True
    refresh_count_before = issuer.refresh_count
    with ThreadPoolExecutor(max_workers=2) as pool:
        in_flight = pool.submit(
            smoke.request,
            info_path,
            headers={"Cookie": default_race_cookie},
            follow=False,
            admin_auth=False,
        )
        if not issuer.refresh_entered.wait(timeout=10):
            issuer.release_refresh.set()
            fail("mock provider did not block the default-role refresh")
        status, _payload, _headers = smoke.admin("/api/v1/role/default", method="DELETE")
        if status not in (200, 204):
            issuer.release_refresh.set()
            fail("clearing default role during refresh failed")
        time.sleep(0.3)
        issuer.release_refresh.set()
        in_flight_result = in_flight.result(timeout=15)
    if in_flight_result[0] != 401:
        fail(f"in-flight refresh survived default-role removal (HTTP {in_flight_result[0]})")
    if issuer.refresh_count != refresh_count_before + 1:
        fail("default-role race did not complete exactly one refresh")
    status, _body, _headers = smoke.request(
        info_path,
        headers={"Cookie": default_race_cookie},
        follow=False,
        admin_auth=False,
    )
    if status != 401:
        fail(f"cookie session was recreated after default-role removal (HTTP {status})")
    if smoke.user_roles(default_race_user):
        fail("removed default role returned after refresh")

    print("OIDC smoke passed: discovery, RS256/JWKS code exchange, group mapping, permission revocation, manual grant protection, serialized refresh, fail-closed refresh, transient refresh failure, default validation/clear, and logout/default invalidation races.")


def main() -> int:
    if shutil.which("openssl") is None:
        fail("OpenSSL executable is required for ephemeral test ID-token signing")
    binary = get_cli_binary()
    runtime = Path(tempfile.mkdtemp(prefix="parseable-oidc-smoke-"))
    provider: MockIssuer | None = None
    process: subprocess.Popen[bytes] | None = None
    log_path = runtime / "parseable.log"
    try:
        provider = MockIssuer(runtime)
        issuer_url = provider.start()
        http_port, grpc_port, flight_port, query_grpc_port = (get_free_port() for _ in range(4))
        base_url = f"http://127.0.0.1:{http_port}"
        username = "oidc-smoke-admin"
        password = uuid.uuid4().hex
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "P_ADDR": f"127.0.0.1:{http_port}",
            "P_GRPC_PORT": str(grpc_port),
            "P_FLIGHT_PORT": str(flight_port),
            "P_QUERY_GRPC_PORT": str(query_grpc_port),
            "P_USERNAME": username,
            "P_PASSWORD": password,
            "P_FS_DIR": str(runtime / "data"),
            "P_STAGING_DIR": str(runtime / "staging"),
            "P_OIDC_CLIENT_ID": CLIENT_ID,
            "P_OIDC_CLIENT_SECRET": CLIENT_SECRET,
            "P_OIDC_ISSUER": issuer_url,
            "P_OIDC_SCOPE": "openid profile email groups",
            "P_CHECK_UPDATE": "false",
            "P_SEND_ANONYMOUS_USAGE_DATA": "false",
            "P_ACTIX_NUM_WORKERS": "1",
        }
        log_file = log_path.open("wb")
        try:
            process = subprocess.Popen(
                [str(binary), "local-store"],
                cwd=runtime,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=log_file,
                stderr=subprocess.STDOUT,
            )
            smoke = Smoke(base_url, username, password)
            wait_for_parseable(smoke, process)
            test_flow(smoke, provider)
        finally:
            if process is not None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            log_file.close()
    finally:
        if provider:
            provider.stop()
        shutil.rmtree(runtime, ignore_errors=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        raise SystemExit(1) from None
