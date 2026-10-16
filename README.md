<h2 align="center">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/parseablehq/.github/main/images/logo-dark.png">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/parseablehq/.github/main/images/logo.svg">
      <a href="https://www.parseable.com" target="_blank"><img src="https://raw.githubusercontent.com/parseablehq/.github/main/images/logo.svg" alt="Parseable logo" /></a>
    </picture>
</h2>

<div class="title-block" style="text-align: center;" align="center">

[![Slack](https://img.shields.io/badge/slack-brightgreen.svg?logo=slack&label=Community&style=flat&color=%2373DC8C&)](https://logg.ing/community)
[![Docs](https://img.shields.io/badge/stable%20docs-parseable.com%2Fdocs-brightgreen?style=flat&color=%2373DC8C&label=Docs)](https://logg.ing/docs)
[![Build](https://img.shields.io/github/checks-status/parseablehq/parseable/main?style=flat&color=%2373DC8C&label=Build)](https://github.com/parseablehq/parseable/actions)

**[Introduction](https://www.parseable.com/docs/introduction) &nbsp;&nbsp;&bull;&nbsp;&nbsp;**
**[Docs](https://parseable.com/docs) &nbsp;&nbsp;&bull;&nbsp;&nbsp;**
**[Features](https://www.parseable.com/docs/features) &nbsp;&nbsp;&bull;&nbsp;&nbsp;**
**[Benchmarks](https://www.parseable.com/docs/benchmarks) &nbsp;&nbsp;&nbsp;&nbsp;**

</div>

Parseable is an open source, columnar data lake platform - purpose built for observability. Send logs, metrics & traces to Parseable via popular logging agents, OpenTelemetry, Kafka, eBPF or other integrations. Use native observability features like alerting, dashboards, anomaly detection, APM, PromQL & SQL - all within a single binary.

## Why Parseable?

Purpose built for observability and designed around proven data engineering patterns, Parseable gives you everything you need to make sense of your telemetry data, right out of the box.

Some of the key highlights include:

- [Data lake architecture](https://www.parseable.com/docs/architecture): Stateless compute over object storage as the backing store. Storage and compute scale independently, so you're not paying for one to grow the other.

- [Fully featured](https://www.parseable.com/docs/features): Parseable is feature complete with alerting, dashboards, anomaly detection, APM, and more, all from a single binary without stitching together multiple tools.

- [Agent ready](https://www.parseable.com/docs/integrations#ai-agents--llms): Whether you need to observe your AI agents or use LLMs to analyze your telemetry data, Parseable supports both natively.

- [OpenTelemetry native](https://www.parseable.com/docs/ingest-data/otel): With native OTel support, you can send telemetry data to Parseable without any custom modifications or plugins. Parseable can be used as a drop-in replacement for your existing OpenTelemetry Collector setup.

## Quickstart

Download the latest published binary from this fork (`VibeEngineeringAI/parseable`).
The installer requires a published release containing the asset for your platform;
it will fail if one is unavailable.

```bash
curl -fsSL https://raw.githubusercontent.com/VibeEngineeringAI/parseable/main/scripts/download.sh | sh
```

<details> 
<summary>For Windows</summary>

```pwsh
powershell -c "irm https://raw.githubusercontent.com/VibeEngineeringAI/parseable/main/scripts/download.ps1 | iex"
```
</details>

Once you have Parseable running, ingest data with the command below. This will send logs to the `demo` stream. You can see the logs in the dashboard.

```bash
curl --location --request POST 'http://localhost:8000/api/v1/ingest' \
--header 'X-P-Stream: demo' \
--header 'Authorization: Basic YWRtaW46YWRtaW4=' \
--header 'Content-Type: application/json' \
--data-raw '[
    {
        "id": "434a5f5e-2f5f-11ed-a261-0242ac120002",
        "datetime": "24/Jun/2022:14:12:15 +0000",
        "host": "153.10.110.81"
    }
]'
```

Access the UI at http://localhost:8000. Log in with the default credentials `admin` / `admin`.

Source builds of this fork include a [community PromQL query API](docs/promql.md) for OTLP metrics, with instant and range queries and no Enterprise dependency. See the guide for the supported language subset and limits.

For production deployments, refer to the [installation guide ↗︎](https://www.parseable.com/docs/self-hosted/installation) for best practices and hardening tips.

> [!TIP]
> Try out the [Parseable cloud](https://app.parseable.com) — 14 days free trial, no credit card required.

## Contributing

Pull requests use the [CI workflow](.github/workflows/ci.yaml) on Blacksmith
8-vCPU Ubuntu 24.04 runners. It selects frontend, Rust, and integration jobs from
the changed paths and reports one aggregate `CI passed` check. Frontend changes
still exercise the embedded UI through the integration image; Rust-only changes
skip the browser suite. A newer PR commit cancels its superseded CI run.

Browser tests run in four shards alongside production and Storybook checks.
Clippy runs alongside Rust tests. Integration builds one cached Docker image and
shares it between standalone and distributed Quest jobs. PRs keep Quest's
functional tests but exclude its six sustained k6 tests. Pushes to `main` and the
nightly run (06:17 UTC) run the full Quest load suite and upload Rust coverage.
Manual CI runs can select `full` to exercise those checks before merging.

Release builds cache Rust dependencies per target, feature set, and profile.
The manual release workflow defaults to the existing fat-LTO profile. Its
`release-thin-lto` option is an experiment that only uploads workflow artifacts;
it accepts a tag, branch, or commit containing that Cargo profile and never
publishes release assets or images. Compare build times and runtime benchmarks
on the same source revision before changing the production profile.

<a href="https://github.com/parseablehq/parseable/graphs/contributors"><img src="https://contrib.rocks/image?repo=parseablehq/parseable" alt="Contributors" /></a>

[Contribution guide ↗︎](https://github.com/parseablehq/parseable/blob/main/CONTRIBUTING.md)

## Verify images

Parseable builds are attested for build provenance and integrity using the [attest-build-provenance](https://github.com/actions/attest-build-provenance) action. The attestations can be verified by having the latest version of [GitHub CLI](https://github.com/cli/cli/releases/latest) installed in your system. Then, execute the following command:

```sh
gh attestation verify PATH/TO/YOUR/PARSEABLE/ARTIFACT-BINARY -R parseablehq/parseable
```

### Editable frontend

An initial React/TypeScript frontend and reusable component library live in
[`frontend/`](frontend/README.md), with Logs Explore, SQL, datasets, local
dashboards, Storybook, and browser tests. Billing and payment collection are
excluded.

Parseable serves it at `/`, and links to its earlier `/next/` mount redirect
there. For one release, `P_UI_ROOT=classic` restores the classic UI at `/` and
mounts the new frontend beside it at `/next/`, sharing the same session. Docker
images and build/release workflows build it with Node 24 and embed
`frontend/dist` through `NEXT_ASSETS_PATH`. To build locally from the
repository root:

```sh
(cd frontend && npm ci && npm run build)
NEXT_ASSETS_PATH="$PWD/frontend/dist" cargo build --release
```

Then open `/`. See the
[frontend README](frontend/README.md#build-and-embed-in-parseable) for build
details, PowerShell instructions, and the classic UI's rollback setting.
