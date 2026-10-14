# Keystone provider foundations

The native runtime now includes optional live generation and encrypted credential entry.
They remain unavailable until operator deployment inputs and an admin-entered credential
are present. Automated verification uses fixtures and local TLS only. No paid call has
validated the configured model against the privacy routing requirements below.

`ModelProvider` and the separate advisory `DecisionProvider` receive a
`FrozenProviderContext` verified from the server-built `PinnedContext`. The wire
input is the same frozen direct-parent package for both decision protocols. No
provider conversation/session identifier, recursive graph access, SQL executor,
tool executor, or scope mutation capability exists on either interface.

| Protocol         | Fixed operation | Pinned model | Native handling                                                                                       |
| ---------------- | --------------- | ------------ | ----------------------------------------------------------------------------------------------------- |
| TypeSafe Jev     | `/v1/systemone` | `jev-1.13.0` | Keyed questions/answers; noul, choice, fractional ordinal score and legend                            |
| OpenAI Decisions | `/v1/decisions` | `gpt-6-luna` | Ordered named questions/answers; predicate, choice, fractional ordinal score and per-question refusal |

Native confidence is retained separately from choice probability. Refusal remains
a distinct outcome. Response validation rejects missing/duplicate/unexpected IDs,
unknown answer fields, incorrect answer kinds, invalid scales/labels,
non-normalized distributions, and scores inconsistent with their native weighted
distribution. Boolean OpenAI choices are outside this portable string-only MVP
and are rejected rather than coerced.

Destination validation derives the fixed endpoint from an operator-approved HTTPS
root, exact origin, port, and gateway prefix. Userinfo, query/fragment, dot-segment
tricks, percent-escaped roots and duplicate API suffixes are rejected. Credential
bindings include origin, prefix, port and policy revision; a change invalidates the
binding. Every DNS address needs its own matching operator CIDR grant; loopback,
link-local and metadata destinations remain denied even under a broad grant. So do
the reserved IPv6 range `::/8`, which includes the IPv4-compatible and
IPv4-translated forms (for example `::ffff:0:7f00:1`), and the discard prefix
`100::/64`. A private address is allowed only by an explicit grant lying entirely
inside its private block; catch-all or wider grants never reach a private gateway.

`EncryptedFileSecretStore` implements AES-256-GCM immutable credential versions with
external deployment master-key input, tenant/version/destination enforcement and exclusive
local locking. Writes are atomic, and unreferenced versions are quarantined recoverably
rather than deleted (see
[credential file recovery](keystone-foundations.md#single-coordinator-deployment-inputs)).
Debug output is redacted and keys never appear in API responses. The pinned
HTTPS transport validates every resolved address, disables redirects/proxies, verifies TLS,
rejects compressed responses, bounds response bytes and enforces deadlines. Local injected
TLS fixtures verify those boundaries without bypassing production policy.

See [deployment inputs](keystone-foundations.md#single-coordinator-deployment-inputs).
Jev/Luna decision adapters remain separate, advisory and disabled in the application;
they do not generate Keystone answers or authorize tools, SQL or scope changes. The
OpenRouter privacy routing below applies only to generation, not to these adapters.

Protocol schemas were checked against [TypeSafe's API reference](https://docs.typesafe.ai/api)
and the [official OpenAI create-decision reference](https://developers.openai.com/api/reference/resources/decisions/methods/create)
on 13 October 2026. The [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions)
confirms zero-based ordinal levels and fractional probability-weighted scores.

## OpenRouter generation adapter

The user-selected OpenRouter API base is `https://openrouter.ai/api/v1`.
`GenerationConfig::openrouter` approves the exact `https://openrouter.ai/api`
origin/prefix and derives `/v1/chat/completions` once. Generic operator-root
validation continues to reject versioned operation URLs. Approved operator
gateways may use `from_operator_chat_root`; tenant settings cannot change roots,
models, routing, token limits, or price caps.

The initial operator model is `xiaomi/mimo-v2.6-flash`; `z-ai/glm-5.3-flash`
is also a validated configurable model. On 13 October 2026 the public model
catalog reported MiMo at $0.14/M input and $0.28/M output, versus GLM at
$0.0261/M input and $0.90/M output. MiMo was chosen for lower output cost.
The current [MiMo endpoint catalog](https://openrouter.ai/api/v1/models/xiaomi/mimo-v2.6-flash/endpoints)
shows varying provider prices, so requests enforce caps of $0.20/M input and
$1.00/M output. These are ceilings, not a fixed bill or quality guarantee.

The [official chat reference](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion)
defines the non-streaming chat envelope. Each request contains exactly one system
instruction and one user message with the frozen context, a single model and
`max_tokens` (initially 2048). It contains no conversation ID, tools, plugins,
fallback model list, session metadata, or prior provider output.
The [provider routing reference](https://openrouter.ai/docs/guides/routing/provider-selection)
documents `allow_fallbacks: false`, `require_parameters: true`, and
`provider.max_price` in dollars per million tokens. Unsupported requested
parameters or unavailable prices fail rather than silently changing policy.

### Privacy routing requirements

Requests include up to 25 sampled log rows per approved dataset, so every request
carries this `provider` block:

```json
{
  "allow_fallbacks": false,
  "require_parameters": true,
  "data_collection": "deny",
  "zdr": true,
  "max_price": { "prompt": 0.2, "completion": 1.0 }
}
```

`data_collection: "deny"` and `zdr: true` are hard requirements. They are not
configurable, and the request never sets `order`, `only`, `ignore`, `sort`,
`models` or `route`. Per OpenRouter's documentation, checked on 13 October 2026:

- [Provider selection](https://openrouter.ai/docs/guides/routing/provider-selection):
  `data_collection` is `"allow"` or `"deny"` and defaults to `"allow"`; `"deny"`
  uses only providers that do not collect user data. `zdr: true` routes only to
  Zero Data Retention endpoints, and the request flag can only add to account-wide
  ZDR settings.
- [Chat completion reference](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion):
  both fields are in the request schema; if no provider meets the
  `data_collection` requirement, the request returns an error.
- [Zero Data Retention](https://openrouter.ai/docs/guides/features/zdr): the
  per-request `{"provider":{"zdr":true}}` form.

**Model availability is not guaranteed.** The configured model may have no endpoint
that meets both requirements within the price caps. The documentation does not
state the `zdr: true` behavior when no ZDR endpoint exists; Keystone assumes the
request fails and never falls back. Such a run fails with the upstream rejection
rather than sending data to a less restricted endpoint. The default model was chosen
for price; its availability under these requirements has not been tested with a
paid call, so no call has confirmed which endpoints serve it. Before
enabling Keystone, check the model's endpoint list and run one controlled call;
choose another model with `KEYSTONE_GENERATION_MODEL` if none qualifies.

### Credential-save capacity

Saving a provider key takes a permit from a dedicated administrator pool (2 per user,
4 per tenant, 64 in total), separate from the run and live-progress pool (8 per user,
32 per tenant, 256 in total). Open live-progress streams therefore cannot prevent a
key save. A save is accepted only with a permit this server issued to the same
principal; permits from another administrator, tenant or server instance are
refused before any write. The administrator check runs before and after the
encrypted write, and saves are serialized.

The [reasoning token guide](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
documents that reasoning can consume the output budget. Requests set
`reasoning.enabled: false` and `exclude: true`; the model catalog advertises
reasoning parameter support. Any returned reasoning is discarded. Responses
must name the configured model and contain exactly one assistant text choice
with `finish_reason: stop`. Refusal, tool/function calls, multimodal output,
errors, incomplete/empty output, duplicate JSON keys and oversized answers fail
closed. Synthetic dispatch fixtures exercise context isolation, destination and
credential binding, error propagation, and these rejection cases without a live
provider call.
