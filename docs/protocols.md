# Protocol support

This page records the implemented subset and pinned revision for each protocol.

## Support matrix

| Protocol | Status       | Revision                                                    | Implemented subset                                                          |
| -------- | ------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| **HTTP** | Supported    | native                                                      | resource routes and rail-specific payment headers                           |
| **MCP**  | Supported    | MCP `2025-11-25` through `@modelcontextprotocol/sdk@1.32.0` | tool discovery, invocation, payment-required and error mapping              |
| **x402** | Supported    | x402 v2, `@x402/core@2.25.0`, `@x402/evm@2.25.0`            | `exact` EVM/EIP-3009 challenge, verification, settlement and replay binding |
| **A2A**  | Experimental | v1.0.0; negotiation `1.0`; `JSONRPC` binding                | Agent Card, `SendMessage`, terminal tasks and paid flow                     |
| **ACP**  | Experimental | stable snapshot `2026-04-17`; REST binding                  | discovery and the five checkout operations                                  |
| **AP2**  | Experimental | v0.2.0, tag 2026-04-28, commit `b4587ac`; Direct mode       | closed Checkout Mandate verification before settlement                      |
| **MPP**  | Experimental | drafts at `tempoxyz/mpp-specs@806fdb8`; `mppx@0.13.1`       | `charge`/`evm`/EIP-3009 over HTTP, MCP and A2A                              |
| UCP      | Planned      | -                                                           | no implementation                                                           |

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
  paid, and authorization instructions when the resource requires it;
- input schema: canonical resource schema plus an optional `_payment` string
  for a paid resource and an optional `_authorization` object
  (`{ method, payload }`) for a resource that requires authorization.

Calling an unknown tool returns JSON-RPC error `-32602`.

### Payment over MCP

A paid tool accepts a proof in the gateway's `_payment` argument or the
selected rail's MCP `_meta` carrier. The latter lets x402 and MPP clients
use their native payment format:

| Rail | Challenge                                                         | Proof                                                      | Delivered result                   |
| ---- | ----------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------- |
| x402 | v2 `PaymentRequired` in `structuredContent` and `content[0].text` | `_meta["x402/payment"]`, a `PaymentPayload` object         | `_meta["x402/payment-response"]`   |
| MPP  | `_meta["org.paymentauth/payment-required"]` with the challenges   | `_meta["org.paymentauth/credential"]`, a credential object | `_meta["org.paymentauth/receipt"]` |

The x402 carrier follows the x402 MCP transport; the MPP carrier follows
`draft-payment-transport-mcp-00`. If a call supplies both `_payment` and
`_meta`, `_payment` takes precedence. The MPP draft sends challenges as
JSON-RPC error `-32042`. This gateway puts them in tool results instead,
which the `mppx` client also accepts.

Without a proof, the tool returns `isError: true` and the gateway's
payment-required envelope in `structuredContent`. For x402, the v2
`PaymentRequired` fields appear alongside that envelope so x402 clients can
read them:

```jsonc
{
  "x402Version": 2,
  "resource": { /* v2 resource descriptor */ },
  "accepts": [ /* x402 payment requirements */ ],
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
`accepts` is its requirements list. A `_payment` retry carries the base64 proof.

For MPP, `envelope.wwwAuthenticate` is the serialized `WWW-Authenticate` value
and `envelope.challenges` holds the challenge objects. A `_payment` retry
carries the complete `Authorization: Payment ...` credential.

When the pipeline supplies a retry challenge, a 402 refusal includes it in
the rail's format. x402 adds the reason in `error`; MPP adds a `problem` with
its problem type. An x402 settlement failure or a backend failure after settlement
also includes `_meta["x402/payment-response"]`. Every failure retains the gateway's
error envelope in `structuredContent`.

For payment-required and error results, `content[0].text` is a JSON copy of
`structuredContent`; `content[1].text` is a sentence for readers. Unexpected
exception messages and stack traces are omitted.

### MCP exclusions

The adapter does not implement MCP resources, prompts, sampling, completions,
elicitation, roots, logging, tasks or tool-list-change notifications. The
gateway, rather than the MCP adapter, enforces Host and Origin checks.

The MCP adapter maps payment carriers and results. It does not verify or
settle payments or call merchant backends.

## A2A

**Experimental.** Enable with `protocols.a2a.enabled: true`.

| Property                | Value                                    |
| ----------------------- | ---------------------------------------- |
| Binding                 | JSON-RPC 2.0 over HTTP(S)                |
| Method                  | `SendMessage`, not legacy `message/send` |
| Required version header | `A2A-Version: 1.0`                       |
| Agent Card              | `GET /.well-known/agent-card.json`       |
| Default mount           | `/a2a`                                   |
| Task model              | synchronous terminal tasks only          |

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

A2A payment uses only `_payment`. The `a2a-x402` extension uses task
continuation, which this adapter does not implement.

### Results

Each accepted invocation returns a terminal task with one artifact:

| Outcome          | State                  | Artifact data                                            |
| ---------------- | ---------------------- | -------------------------------------------------------- |
| delivered        | `TASK_STATE_COMPLETED` | merchant response and `agent-commerce/delivery` metadata |
| payment required | `TASK_STATE_FAILED`    | shared payment-required envelope                         |
| commerce failure | `TASK_STATE_FAILED`    | shared error envelope                                    |

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

The A2A adapter accepts `_payment` but does not verify or settle payments
or call merchant backends. `@a2a-js/sdk` is a test-only dependency.

## ACP

**Experimental.** Enable with `protocols.acp.enabled: true`.

| Property                            | Value                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------ |
| Binding                             | REST over HTTP(S)                                                        |
| Snapshot and accepted `API-Version` | `2026-04-17` only                                                        |
| Vendored schema                     | `src/protocols/acp/spec/2026-04-17/`                                     |
| Discovery                           | `GET /.well-known/acp.json`                                              |
| Default mount                       | `/acp`                                                                   |
| Service                             | `checkout` only                                                          |
| Authentication                      | bearer token on every checkout route                                     |
| Idempotency                         | durable key on every POST, completed rows retained for at least 24 hours |

The schema is vendored and never fetched. Runtime code imports only the dated
snapshot; it reads nothing from `spec/unreleased`. The adapter validates its
discovery document at startup and fails with `CONFIG_INVALID` if it does not
match. A version upgrade adds a new snapshot rather than editing this one.

### Required headers

| Header            | Scope                | Rule                                                                                                                                       |
| ----------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Authorization`   | every checkout route | `Bearer <token>`, constant-time comparison                                                                                                 |
| `API-Version`     | every checkout route | exactly `2026-04-17`; missing and unsupported are distinct errors                                                                          |
| `Content-Type`    | every POST           | if present, `application/json` or any media type ending in `+json`; an empty body may omit it, but a supplied non-JSON type still gets 415 |
| `Idempotency-Key` | every POST           | 1-255 printable ASCII characters                                                                                                           |
| `Request-Id`      | optional             | bounded and filtered; echoed after request guards unless handling ends in the catch-all 500; not the gateway request id                    |

An absent, older, newer or malformed API version is not mapped to the supported
snapshot.

### Checkout operations

| Operation                 | Route                                          | Success | Canonical input                     |
| ------------------------- | ---------------------------------------------- | ------- | ----------------------------------- |
| `createCheckoutSession`   | `POST {mount}/checkout_sessions`               | `201`   | `{ body }`                          |
| `updateCheckoutSession`   | `POST {mount}/checkout_sessions/{id}`          | `200`   | `{ path, body }`                    |
| `getCheckoutSession`      | `GET {mount}/checkout_sessions/{id}`           | `200`   | `{ path }`                          |
| `completeCheckoutSession` | `POST {mount}/checkout_sessions/{id}/complete` | `200`   | `{ path, body }`                    |
| `cancelCheckoutSession`   | `POST {mount}/checkout_sessions/{id}/cancel`   | `200`   | `{ path }`, plus `body` if supplied |

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

| Situation                                                                  | Response                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| first request                                                              | atomically claimed before merchant execution                                          |
| same key and body, still running                                           | `409 idempotency_in_flight` with `Retry-After`                                        |
| same key and body, completed                                               | stored response with `Idempotent-Replayed: true`; no merchant call                    |
| same key, different body                                                   | `422 idempotency_conflict`; no merchant call                                          |
| ACP response below 500 after the claim, including pipeline `INPUT_INVALID` | cached                                                                                |
| ACP response 500 or higher after the merchant may have run                 | `409 idempotency_unresolved` on retry, without `Retry-After`; no second merchant call |
| ACP response 500 or higher when the merchant was not called                | claim released; a clean retry may run                                                 |

The ACP response status controls finalization, not the merchant's raw status. A
merchant 401 or 403 maps to ACP 502 and becomes unresolved, while a
post-claim pipeline `INPUT_INVALID` maps to ACP 400 and is cached. Request-guard
failures occur before the claim and are never stored: 404 or 405 routing,
authentication failure, missing or invalid idempotency and API-version headers,
an unreadable or oversized body, invalid JSON or schema, or an unsupported
content type. A guard failure does not echo `Request-Id`.

An in-flight row becomes completed, released or unresolved when the request
finishes. A crash or a SQLite error while finalizing can leave it in-flight;
the next gateway start marks every remaining in-flight row unresolved and logs
a warning with the count. This assumes one gateway process per idempotency
database file.

Only completed records expire, after at least 24 hours. Unresolved records
remain for operator reconciliation. This avoids rerunning an unknown remote
side effect but is not an exactly-once transaction across HTTP and SQLite.
Expired completed rows are purged lazily when a later request claims a key;
there is no background sweep.

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

| Cause                                             | Response                              |
| ------------------------------------------------- | ------------------------------------- |
| pipeline `INPUT_INVALID`                          | `400 invalid_request_body`            |
| merchant 404                                      | `404 checkout_session_not_found`      |
| merchant 405 on cancel                            | `405 checkout_session_not_cancelable` |
| merchant 405 on another operation                 | `405 method_not_allowed`              |
| merchant 400 or 422                               | `422 invalid_request_body`            |
| merchant 409                                      | `409 checkout_session_conflict`       |
| merchant 401, 403, 5xx or another unmapped status | `502 processing_error`                |
| backend timeout                                   | `504 service_unavailable`             |
| load shedding                                     | `503 service_unavailable`             |
| mapping, storage or unexpected payment challenge  | `500 processing_error`                |

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
payer balance, network and asset. Local refusals use x402 error codes where
available, such as `invalid_network`. The provider derives a replay key from
the authorization, which the pipeline reserves before settlement. A successful
settlement records the transaction hash.

Settlement runs before the backend call, so requirements declare
`extra.paymentFlow: "upfront"`. A backend failure after settlement leaves the
buyer charged; the gateway records the receipt as undelivered.

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

The gateway targets `draft-httpauth-payment-01`,
`draft-payment-intent-charge-00`, and `draft-evm-charge-00` at
`tempoxyz/mpp-specs@806fdb8`. It pins the pre-1.0 `mppx@0.13.1` as an
optional peer. For EIP-3009, the gateway follows `mppx`: it hashes
`JSON.stringify([id, realm])` with keccak256 to derive the nonce. The EVM
draft instead hashes `abi.encodePacked(id, realm)`. Credentials using the
draft nonce, including those produced by `mppx` 0.12 or earlier, fail
verification with `wrong_nonce`.

Later drafts or `mppx` releases may change the wire format again, so MPP
remains experimental.

The implemented profile is `charge` intent, `evm` method and EIP-3009
`authorization` credential, using USDC on Base Sepolia or Base. The challenge
is HMAC-bound to the resource and terms. The credential is verified locally,
then checked by the x402 settlement provider. Both checks run in `verify`,
before replay reservation; settlement broadcasts later.

MPP and x402 derive the same replay identity for the same EIP-3009
authorization, so reuse across rails collides in one receipt store.

Over HTTP, MPP verification, replay, settlement, and provider errors use
`application/problem+json` and the core draft's problem types. The gateway
keeps `code`, `message`, and `details` as extension members. A successful
`Payment-Receipt` includes `challengeId` and `chainId`.

Terminate TLS in front of deployed MPP endpoints. The core draft forbids
issuing challenges over plain HTTP.

Base mainnet deployments must satisfy the
[mainnet guardrails](configuration.md#mainnet-guardrails).

Unsupported variants are listed in `src/payments/mpp/descriptor.ts`: non-EVM
methods, Permit2/transaction/hash credentials, splits, subscriptions, EVM
sessions, the discovery extension and challenge `digest` binding.

## HTTP surface

| Route                                              | Purpose                                                    |
| -------------------------------------------------- | ---------------------------------------------------------- |
| `GET /health`                                      | liveness                                                   |
| `GET /ready`                                       | readiness for the store, adapters and configured providers |
| `GET /.well-known/agent-commerce`                  | merchant, protocol and provider discovery                  |
| `GET /api/resources`                               | canonical resource list                                    |
| `POST /api/resources/:id/invoke`                   | invoke; returns 402 when proof is absent                   |
| `GET /api/receipts`, `GET /api/events`             | operator audit                                             |
| `/mcp`                                             | MCP Streamable HTTP when enabled                           |
| `/.well-known/agent-card.json`, `/a2a`             | A2A discovery and JSON-RPC when enabled                    |
| `/.well-known/acp.json`, `/acp/checkout_sessions…` | ACP discovery and checkout when enabled                    |

The invoke route uses the selected rail's headers:

| Rail | Proof                        | Challenge on 402                | Refused proof or spent authorization (402) | Refused settlement (402)                                                | Delivered response                       | Backend error after settlement |
| ---- | ---------------------------- | ------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------- | ------------------------------ |
| x402 | `PAYMENT-SIGNATURE`          | `PAYMENT-REQUIRED`              | a fresh `PAYMENT-REQUIRED` with `error`    | `PAYMENT-RESPONSE` with `success: false`                                | `PAYMENT-RESPONSE`                       | `PAYMENT-RESPONSE`             |
| MPP  | `Authorization: Payment ...` | `WWW-Authenticate: Payment ...` | a fresh `WWW-Authenticate`                 | a fresh `WWW-Authenticate` and `PAYMENT-RESPONSE` with `success: false` | `Payment-Receipt` and `PAYMENT-RESPONSE` | `PAYMENT-RESPONSE`             |

The error body carries `details.challenge` when the pipeline supplies a
retry challenge. Other outcomes:

- A replay returns 409 without a challenge if the first attempt is unfinished,
  has the legacy `failed` status, or its status is unavailable. Issuing another
  challenge could lead to a second payment for the same request.
- A settlement without a verdict returns 502 with `PAYMENT-RESPONSE`. Its
  reason is `settlement_pending` when a transaction hash is available, or
  `unexpected_settle_error` otherwise.
- A settled `PAYMENT-RESPONSE` includes `amount` in base units when the
  provider supplies it. Paid deliveries use `Cache-Control: private`; fresh
  402 challenges use `no-store`.

## Adding an integration

See [contributing-adapters.md](contributing-adapters.md). Adapter and provider
implementations keep protocol-specific logic outside `src/core`; new protocol
or rail names require an approved frozen-contract change.
