# Isolated local Keystone smoke setup

A recipe for running native Keystone on one development machine with synthetic data, separate
from any other Parseable installation. It is a local test, not a release deployment. Replace every
`<placeholder>` with a value for your machine; nothing here is a working credential.

## Runtime layout

Create one private runtime directory and keep everything for this instance inside it:

```sh
RUNTIME="<runtime-dir>"        # e.g. a directory under your XDG data home
umask 077
mkdir -p "$RUNTIME"/{data,staging,keystone,logs}
chmod 700 "$RUNTIME"
```

- `data`, `staging` and `keystone` are absolute paths under the runtime root, used for the
  local-store data directory (`P_FS_DIR`), `P_STAGING_DIR` and `KEYSTONE_NATIVE_DIRECTORY`.
- Generate a local application password and a fresh master key into mode-`0600` files. Read them
  locally; never paste them into chat, a wiki, a URL, a command argument or tool output:

  ```sh
  openssl rand -base64 24 > "$RUNTIME/admin-password.txt"
  openssl rand -hex 32 > "$RUNTIME/master-key.hex"
  chmod 600 "$RUNTIME/admin-password.txt" "$RUNTIME/master-key.hex"
  ```

- The application password is the Parseable login (`P_USERNAME` / `P_PASSWORD`), not the provider
  key. The master key (`KEYSTONE_SECRET_MASTER_KEY_HEX`) must be preserved across restarts;
  regenerating it makes stored provider credentials unreadable.

## Process environment

Start the server from a launcher that builds an explicit, clean environment instead of inheriting
your shell's. A suitable launcher:

- sets `P_ADDR=127.0.0.1:<http-port>` and distinct unused `P_GRPC_PORT`, `P_FLIGHT_PORT` and
  `P_QUERY_GRPC_PORT` values, so this instance cannot collide with another one;
- sets `P_FS_DIR`, `P_STAGING_DIR`, `KEYSTONE_NATIVE_DIRECTORY`, `P_USERNAME` and `P_PASSWORD`
  from the runtime directory, and `KEYSTONE_SECRET_MASTER_KEY_HEX` from `master-key.hex`, without
  echoing values;
- sets `P_CHECK_UPDATE=false`, `P_SEND_ANONYMOUS_USAGE_DATA=false` and a modest log level such as
  `RUST_LOG=warn,parseable=info`;
- disables core dumps (`ulimit -c 0`), because the process environment holds the master key;
- refuses to start when a port is already in use, runs in the foreground, writes its process ID to
  `$RUNTIME/server.pid` and logs to `$RUNTIME/logs/server.log`.

Run the `local-store` mode so a single process is the all-in-one coordinator. That one process is
the **only** server with `KEYSTONE_NATIVE_DIRECTORY` set; the local file lock is not distributed
fencing (see
[deployment inputs](keystone-foundations.md#single-coordinator-deployment-inputs)).

A matching stop helper should confirm that the PID in `server.pid` belongs to this runtime
directory and executable before sending SIGTERM. Restart with the same directory and master key; do
not regenerate credentials. Install no system service or automatic startup for a smoke instance.

An existing smoke instance keeps running the build it was started with. Rebuild and restart it to
exercise later changes; until then, results from it say nothing about those changes.

If a restart reports quarantined credential files, do not delete them. Check that
`providers.json` is the version you expect; restoring the correct manifest and restarting moves
referenced files back automatically (see
[credential file recovery](keystone-foundations.md#single-coordinator-deployment-inputs)).

## Embedded UI

Build the native frontend and embed it with `NEXT_ASSETS_PATH` (see
[build-time UI assets](keystone-foundations.md#build-time-ui-assets)). A classic-UI placeholder in
`LOCAL_ASSETS_PATH` avoids downloading the classic bundle, but then the classic UI is not
available or tested on this instance. Open `http://127.0.0.1:<http-port>/keystone`.

## Provider egress

`KEYSTONE_PROVIDER_ALLOWED_CIDRS` is required before any provider call can happen. For a smoke
test, allow only the provider's currently resolved public addresses, each as its own `/32` (IPv4)
or `/128` (IPv6) network:

```sh
getent ahosts openrouter.ai   # inspect; then list each address as <a.b.c.d>/32 or <v6>/128
```

When the provider's DNS rotates to an unlisted address, requests fail closed until the policy is
updated and the server restarted. Do not use `0.0.0.0/0` or `::/0`. A catch-all grant would not
reach a private gateway anyway: private addresses need their own narrow private CIDR (see
[deployment inputs](keystone-foundations.md#single-coordinator-deployment-inputs)).

Generation uses the fixed OpenRouter API base and the model in `KEYSTONE_GENERATION_MODEL` (default
`xiaomi/mimo-v2.6-flash`). Every request requires no-data-collection and zero-data-retention
routing; see [privacy routing requirements](keystone-providers.md#privacy-routing-requirements).
The default model may have no qualifying endpoint within the price caps, in which case runs fail
rather than relaxing those requirements. Jev/Luna remain disabled.

## Remote access

Keep every listener on loopback and check with `ss -ltnp` that nothing else is bound. To reach the
instance from another of your own devices, put a private TLS reverse proxy in front of the HTTP
port, reachable only on your private network, for example
`https://<private-host>:<proxy-port>/keystone`. Do not publish it to the public Internet. Confirm
TLS, the login redirect and cookie-authenticated `GET /api/prism/v1/keystone/native/capabilities`
through that address, and remove only that proxy route when finished.

## Private key entry

Sign in, then expand **OpenRouter connection** on the investigation list. Enter the OpenRouter key
in a regular browser with recording disabled: stop browser tests, traces, screenshots and screen
recordings first. Do not enter it into Storybook, chat, a URL or a wiki.

Choose **Save credential**. Storage readiness and key entry can be checked without a provider key;
saving a key never starts a question. Account and model compatibility require a real run, so agree
a spending ceiling before the first paid call.

## Smoke checklist

These checks need no provider key and make no provider calls:

1. `GET /api/v1/liveness` and `/api/v1/readiness` return 200.
2. Basic-authenticated and browser-cookie-authenticated
   `GET /api/prism/v1/keystone/native/capabilities` return 200 with storage and the secret store
   ready and generation unconfigured.
3. Ingest a small synthetic dataset once, flush it to Parquet, and count it through the query API.
4. Save a 30-day investigation draft; confirm it has one node and no runs, evidence or answers.
5. Restart gracefully with the same runtime directory and master key; the investigation ID and
   all rows survive, and the encrypted store reopens.
6. With a browser guard counting native mutations, open and reload the draft and a run link. Expect
   **zero run requests and zero credential writes** unless you deliberately run a question.

The new-investigation picker offers only datasets whose metadata reports `streamType: UserDefined`;
internal datasets such as `pstats` are never offered, and the backend rejects them regardless.

Smoke artifacts (logs, screenshots, browser results) belong outside the repository, for example
under `$RUNTIME` or a private scratch directory. They are not part of this change.
