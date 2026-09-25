# Protocol support

This page records the implemented subset and pinned revision for each protocol.

## Support matrix

| Protocol | Status | Revision | Implemented subset |
| --- | --- | --- | --- |
| **HTTP** | Supported | native | resource routes and rail-specific payment headers |
| **MCP** | Supported | MCP `2025-11-25` through `@modelcontextprotocol/sdk@1.30.0` | tool discovery, invocation, payment-required and error mapping |
| **x402** | Supported | x402 v2, `@x402/core@2.23.0`, `@x402/evm@2.23.0` | `exact` EVM/EIP-3009 challenge, verification, settlement and replay binding |
| **A2A** | Experimental | v1.0.0; negotiation `1.0`; `JSONRPC` binding | Agent Card, `SendMessage`, terminal tasks and paid flow |
| **ACP** | Experimental | stable snapshot `2026-04-17`; REST binding | discovery and the five checkout operations |
| **AP2** | Experimental | v0.2.0, tag 2026-04-28, commit `b4587ac`; Direct mode | closed Checkout Mandate verification before settlement |
| **MPP** | Experimental | `-00` drafts at `tempoxyz/mpp-specs@806fdb8`; `mppx@0.10.1` | `charge`/`evm`/EIP-3009 over HTTP, MCP and A2A |
| UCP | Planned | - | no implementation |

Experimental components are disabled unless configured and support only the
subsets below. Planned means there is no adapter or endpoint.

AP2 is an authorization method, not a transport or payment rail. It appears in
`authorizationProviders` in gateway discovery and has no AP2-specific mount or
discovery endpoint. See [ap2.md](ap2.md).

An AP2-gated resource still requires its configured payment proof. A mandate
authorizes the purchase but does not settle it.

`GET /.well-known/agent-commerce` reports descriptors for registered adapters
and providers, including `supportedSpec`, `capabilities`, `unsupported` and
`status`. When enabled, A2A, ACP and AP2 also print their detailed unsupported
lists in `agent-commerce doctor`.

## MCP

Resources with `expose: [mcp]` become MCP tools:

- tool name: resource id;
- description: resource description, plus price and proof instructions when
  paid;
- input schema: canonical resource schema plus optional `_payment` for a paid
  resource. `_authorization` is accepted at invocation time but is not
  advertised in the tool schema.

### Payment over MCP

MCP has no payment-header channel, so a missing proof returns the shared
payment-required envelope:

```jsonc
{
  "status": "payment-required",
  "code": "PAYMENT_REQUIRED",
  "requestId": "...",
  "resourceId": "market_report",
  "message": "Payment of 0.01 USDC is required for resource \"market_report\". …",
  "payment": {
    "provider": "x402",
    "version": "2",
    "amount": "0.01",
    "currency": "USDC",
    "destination": "0x…",
    "network": "eip155:84532",
    "asset": "0x…",
    "expiresAt": "…",
    "accepts": [ /* provider-native requirements */ ],
    "envelope": { /* provider-native challenge document */ }
  }
}
```

For x402, `envelope` is the complete v2 `PaymentRequired` document and
`accepts` is its requirements list. The client retries the tool call with the
base64 proof in `_payment`.

For MPP, `accepts` contains the challenge and
`envelope.wwwAuthenticate` contains its serialized `WWW-Authenticate`
value. The retry carries the complete `Authorization: Payment ...` credential
in `_payment`.

Payment-required results set `isError: true`. Other failures use the shared
error envelope. Internal errors and stack traces are not included.

### MCP exclusions

The adapter does not implement MCP resources, prompts, sampling, completions,
elicitation, roots, logging, tasks or tool-list-change notifications. The
gateway, rather than the MCP adapter, enforces Host and Origin checks.

The adapter contains no payment logic and does not call merchant backends.

## A2A

**Experimental.** Enable with `protocols.a2a.enabled: true`.

| Property | Value |
| --- | --- |
| Binding | JSON-RPC 2.0 over HTTP(S) |
| Method | `SendMessage`, not legacy `message/send` |
| Required version header | `A2A-Version: 1.0` |
| Agent Card | `GET /.well-known/agent-card.json` |
| Default mount | `/a2a` |
| Task model | synchronous terminal tasks only |

Resources exposed through A2A become Agent Card skills. The skill id is the
resource id; paid skills are tagged `paid` and include their price in the
description. A2A v1.0 `AgentSkill` has no input-schema field, so the canonical
schema is not embedded in the card.

### Invocation and payment

`SendMessage` must contain one structured-data part:

```json
{
  "data": {
    "resource": "market_report",
    "input": { "symbol": "ETH" }
  },
  "mediaType": "application/json"
}
```

A paid retry adds the same reserved field used by MCP:

```json
{
  "data": {
    "resource": "market_report",
    "input": {
      "symbol": "ETH",
      "_payment": "<payment proof>"
    }
  },
  "mediaType": "application/json"
}
```

Text, file, inline-byte and URL parts; multipart messages; non-user roles; and
task or context continuation are refused.

### Results

Each accepted invocation returns a terminal task with one artifact:

| Outcome | State | Artifact data |
| --- | --- | --- |
| delivered | `TASK_STATE_COMPLETED` | merchant response and `agent-commerce/delivery` metadata |
| payment required | `TASK_STATE_FAILED` | shared payment-required envelope |
| commerce failure | `TASK_STATE_FAILED` | shared error envelope |

A non-object merchant body is wrapped as `{ "value": ... }`. Payment required
is terminal because there is no task store; the buyer sends a new message with
the proof.

JSON-RPC errors are reserved for malformed or unsupported A2A requests:
`-32700`, `-32600`, `-32601`, `-32602`, `-32603`, and `-32004`
(`UnsupportedOperationError`) for recognized operations, versions or message
features this deployment declines, including text/file parts and task or
context continuation.

### A2A exclusions

Unsupported methods are `SendStreamingMessage`, `GetTask`, `ListTasks`,
`CancelTask`, `SubscribeToTask`, the four task-push-notification-config
methods and `GetExtendedAgentCard`. The adapter also excludes REST and gRPC
bindings, SSE, persistent or resumable tasks, push delivery, multi-turn
continuation, authenticated extended cards, A2A authentication and other
artifact types.

The adapter contains no payment logic or direct backend call.
`@a2a-js/sdk` is a test-only dependency.

## ACP

**Experimental.** Enable with `protocols.acp.enabled: true`.

| Property | Value |
| --- | --- |
| Binding | REST over HTTP(S) |
| Snapshot and accepted `API-Version` | `2026-04-17` only |
| Vendored schema | `src/protocols/acp/spec/2026-04-17/` |
| Discovery | `GET /.well-known/acp.json` |
| Default mount | `/acp` |
| Service | `checkout` only |
| Authentication | bearer token on every checkout route |
| Idempotency | durable key on every POST, completed rows retained for at least 24 hours |

The schema is vendored and never fetched. Runtime code imports only the dated
snapshot; it reads nothing from `spec/unreleased`. The adapter validates its
discovery document at startup and fails with `CONFIG_INVALID` if it does not
match. A version upgrade adds a new snapshot rather than editing this one.

### Required headers

| Header | Scope | Rule |
| --- | --- | --- |
| `Authorization` | every checkout route | `Bearer <token>`, constant-time comparison |
| `API-Version` | every checkout route | exactly `2026-04-17`; missing and unsupported are distinct errors |
| `Content-Type` | every POST | if present, `application/json` or any media type ending in `+json`; an empty body may omit it, but a supplied non-JSON type still gets 415 |
| `Idempotency-Key` | every POST | 1-255 printable ASCII characters |
| `Request-Id` | optional | bounded and filtered; echoed after request guards unless handling ends in the catch-all 500; not the gateway request id |

An absent, older, newer or malformed API version is not mapped to the supported
snapshot.

### Checkout operations

| Operation | Route | Success | Canonical input |
| --- | --- | --- | --- |
| `createCheckoutSession` | `POST {mount}/checkout_sessions` | `201` | `{ body }` |
| `updateCheckoutSession` | `POST {mount}/checkout_sessions/{id}` | `200` | `{ path, body }` |
| `getCheckoutSession` | `GET {mount}/checkout_sessions/{id}` | `200` | `{ path }` |
| `completeCheckoutSession` | `POST {mount}/checkout_sessions/{id}/complete` | `200` | `{ path, body }` |
| `cancelCheckoutSession` | `POST {mount}/checkout_sessions/{id}/cancel` | `200` | `{ path }`, plus `body` if supplied |

Each operation maps to a resource in
`protocols.acp.checkout.operations`. All five mappings are required, and each
operation must use a different resource. Each resource must include
`expose: [acp]`, be free at the Agent Commerce invocation layer and have an
empty payments list.

Request bodies are validated against the pinned schema before pipeline
execution; an invalid request returns `400 invalid_request_body`. Successful
merchant responses are validated before return. An invalid merchant document or
success status outside the ACP contract becomes a safe `processing_error`; the
merchant body is not relayed or cached.

Completion accepts the schema's two outcomes: a completed session with an
order, or an ordinary non-completed session without one.

See [examples/acp-checkout](../examples/acp-checkout).

### ACP payment boundary

ACP `payment_data` belongs to the merchant checkout flow. It remains ordinary
backend input and is not converted into an Agent Commerce `_payment`, x402 or
MPP proof.

Config rejects paid checkout resources. If the pipeline nevertheless returns a
payment challenge, the adapter logs the broken deployment and returns a safe
500 because ACP has no Agent Commerce challenge representation.

The ACP adapter contains no payment logic and never calls a merchant backend
directly; it sends one canonical request through the pipeline. Its bearer token
is used only for constant-time request authentication and is not written to the
idempotency database, logs or responses.

### Idempotency

The adapter validates `Idempotency-Key` before reading a POST body. After body
parsing, it claims the key before calling the merchant. The scope is
`(deployment public base URL, concrete endpoint path, caller key)`; bearer
credentials are not part of it. Two clients using the same caller key on the
same endpoint therefore share one claim.

The body fingerprint uses parsed JSON. Object key order and numeric spelling
such as `1` versus `1.0` normalize; array order, type, and null versus absence
remain distinct.

| Situation | Response |
| --- | --- |
| first request | atomically claimed before merchant execution |
| same key and body, still running | `409 idempotency_in_flight` with `Retry-After` |
| same key and body, completed | stored response with `Idempotent-Replayed: true`; no merchant call |
| same key, different body | `422 idempotency_conflict`; no merchant call |
| ACP response below 500 after the claim, including pipeline `INPUT_INVALID` | cached |
| ACP response 500 or higher after the merchant may have run | `409 idempotency_unresolved` on retry, without `Retry-After`; no second merchant call |
| ACP response 500 or higher when the merchant was not called | claim released; a clean retry may run |

The ACP response status controls finalization, not the merchant's raw status. A
merchant 401 or 403 maps to ACP 502 and becomes unresolved, while a
post-claim pipeline `INPUT_INVALID` maps to ACP 400 and is cached. Request-guard
failures occur before the claim and are never stored: 404 or 405 routing,
authentication failure, missing or invalid idempotency and API-version headers,
an unreadable or oversized body, invalid JSON or schema, or an unsupported
content type. A guard failure does not echo `Request-Id`.

A normal in-flight row becomes completed, released or unresolved when the
request finishes. A crash or a SQLite error while completing, releasing or
marking the row unresolved can leave it in-flight for an operator to reconcile.

Only completed records expire, after at least 24 hours. Unresolved records and
in-flight rows left by a crash or finalization error remain for operator
reconciliation. This avoids rerunning an unknown remote side effect but is not
an exactly-once transaction across HTTP and SQLite. Expired completed rows are
purged lazily when a later request claims a key; there is no background sweep.

The schema-v1-to-v2 migration rebuilds the idempotency table empty because its
bearer-token-scoped keys cannot be translated. If it drops non-completed rows,
startup logs a warning that tells the operator to reconcile them with the
merchant before trusting a retry.

For side-effecting ACP operations, the gateway sends the merchant a derived
`Idempotency-Key`: SHA-256 over deployment, endpoint and caller key. It is
stable across retries, restarts and bearer-token rotation; differs across
endpoints and deployments; and reveals no caller key. A static
`Idempotency-Key` in backend headers is replaced by this derived value.

The merchant should store and replay results under the derived key. Without
merchant-side idempotency, gateway-visible retries remain protected, but a
proxy retry or duplicate delivery outside the gateway can repeat the side
effect.

### ACP errors

| Cause | Response |
| --- | --- |
| pipeline `INPUT_INVALID` | `400 invalid_request_body` |
| merchant 404 | `404 checkout_session_not_found` |
| merchant 405 on cancel | `405 checkout_session_not_cancelable` |
| merchant 405 on another operation | `405 method_not_allowed` |
| merchant 400 or 422 | `422 invalid_request_body` |
| merchant 409 | `409 checkout_session_conflict` |
| merchant 401, 403, 5xx or another unmapped status | `502 processing_error` |
| backend timeout | `504 service_unavailable` |
| load shedding | `503 service_unavailable` |
| mapping, storage or unexpected payment challenge | `500 processing_error` |

ACP errors contain `type`, `code`, `message`, a safe `param` when available, and
`supported_versions` for API-version errors. They omit merchant bodies, stack
traces, database errors, paths and credentials. Merchant 401/403 is not
presented as a failure of the agent's ACP bearer token.

### ACP discovery

```json
{
  "protocol": {
    "name": "acp",
    "version": "2026-04-17",
    "supported_versions": ["2026-04-17"]
  },
  "api_base_url": "https://merchant.example.com/acp",
  "transports": ["rest"],
  "capabilities": { "services": ["checkout"] }
}
```

Discovery is public while ACP is enabled and uses
`Cache-Control: public, max-age=3600`. Optional documentation, currency,
locale and intervention metadata appears only when configured. Tokens, backend
URLs, resource ids and database paths are excluded.

### ACP exclusions

The adapter excludes carts, feed and standalone orders; delegated payment and
authentication; the ACP MCP binding; webhooks and outbound delivery; the client
role; `Signature` and `Timestamp` verification; discounts and the general
extension framework; seller-backed payment handlers; and other ACP versions.
A `Signature` header does not replace bearer authentication.

No ACP SDK ships. Conformance tests use the vendored official schema and
examples.

## x402

The x402 provider supports v2 `exact` on EVM through EIP-3009
`transferWithAuthorization`. Requirements explicitly include the token name
and version used by the EIP-712 domain.

Verification checks the scheme, signature, recipient, amount, validity window,
payer balance, network and asset. The provider computes a replay key from the
authorization, and the pipeline reserves it before settlement. A successful
settlement records the transaction hash.

Unsupported: SVM, Permit2, `upto`, `deferred`, multi-asset routing and
dynamic pricing.

Facilitator authentication supports `none`, `bearer` and `cdp`; config rejects
other auth types. Remote mode works on Base Sepolia. Config accepts local mode
there with a non-Anvil key, but local health checks require Anvil, so a
deployment against public Base Sepolia reports unhealthy. Base mainnet requires
remote mode and the guardrails in
[configuration.md](configuration.md#mainnet-guardrails).

## MPP

**Experimental.** Enable with `payments.mpp.enabled: true`.

The wire format follows three `-00` drafts read at `tempoxyz/mpp-specs@806fdb8`
and the pre-1.0 `mppx@0.10.1`, which the package pins exactly as an optional
peer. A later draft or `mppx` release can change the wire format, so a buyer on
another `mppx` version may fail to pay. MPP stays experimental until the
specification is stable.

The implemented profile is `charge` intent, `evm` method and EIP-3009
`authorization` credential, using USDC on Base Sepolia or Base. The challenge
is HMAC-bound to the resource and terms. The credential is verified locally,
then checked by the x402 settlement provider. Both checks run in `verify`,
before replay reservation; settlement broadcasts later.

MPP and x402 derive the same replay identity for the same EIP-3009
authorization, so reuse across rails collides in one receipt store.

Base mainnet deployments must satisfy the
[mainnet guardrails](configuration.md#mainnet-guardrails).

Unsupported variants are listed in `src/payments/mpp/descriptor.ts`: non-EVM
methods, Permit2/transaction/hash credentials, splits, subscriptions, EVM
sessions and discovery extension.

## HTTP surface

| Route | Purpose |
| --- | --- |
| `GET /health` | liveness |
| `GET /ready` | readiness for the store, adapters and configured providers |
| `GET /.well-known/agent-commerce` | merchant, protocol and provider discovery |
| `GET /api/resources` | canonical resource list |
| `POST /api/resources/:id/invoke` | invoke; returns 402 when proof is absent |
| `GET /api/receipts`, `GET /api/events` | operator audit |
| `GET /api/events/stream` | operator SSE event stream |
| `/mcp` | MCP Streamable HTTP when enabled |
| `/.well-known/agent-card.json`, `/a2a` | A2A discovery and JSON-RPC when enabled |
| `/.well-known/acp.json`, `/acp/checkout_sessions…` | ACP discovery and checkout when enabled |

The invoke route uses the selected rail's headers:

| Rail | Proof | Challenge on 402 | Rejected proof (402) | Delivered response | Backend error after settlement |
| --- | --- | --- | --- | --- | --- |
| x402 | `PAYMENT-SIGNATURE` | `PAYMENT-REQUIRED` | none | `PAYMENT-RESPONSE` | `PAYMENT-RESPONSE` |
| MPP | `Authorization: Payment ...` | `WWW-Authenticate: Payment ...` | a fresh `WWW-Authenticate: Payment ...` | `Payment-Receipt` and `PAYMENT-RESPONSE` | `Payment-Receipt` and `PAYMENT-RESPONSE` |

The body of a rejected proof's error carries the rail's fresh challenge as
`details.challenge` on both rails.

## Adding an integration

See [contributing-adapters.md](contributing-adapters.md). Adapter and provider
implementations keep protocol-specific logic outside `src/core`; new protocol
or rail names require an approved frozen-contract change.
