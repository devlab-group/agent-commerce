# Protocol support

Alpha honesty is a release requirement: this page states exactly what is
implemented, exactly what is not, and pins the revisions.

## Support matrix

| Protocol | Status    | Revision                                                                             | What works                                                          |
| -------- | --------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| **MCP**  | Supported | `@modelcontextprotocol/sdk@1.30.0`                                                   | tool discovery, tool invocation, payment-required and error mapping |
| **x402** | Supported | x402 **v2** (`@x402/core@2.23.0`, `@x402/evm@2.23.0`), scheme `exact`, EVM, EIP-3009 | challenge, verification, settlement, replay binding                 |
| **HTTP** | Supported | —                                                                                    | native resource routes with `PAYMENT-SIGNATURE`                     |
| **A2A**  | Experimental | A2A **v1.0.0**, negotiation version `1.0`, binding `JSONRPC`                     | Agent Card discovery, `SendMessage`, terminal tasks, paid flow      |
| **ACP**  | Experimental | ACP stable snapshot **2026-04-17**, REST binding                                 | discovery, the five checkout operations, bearer auth, idempotency   |
| UCP      | Planned   | —                                                                                    | planned, no code ships                                                         |
| MPP      | Planned   | —                                                                                    | planned, no code ships                                                         |
| AP2      | Planned   | —                                                                                    | planned, no code ships                                                         |

"Planned" means **no code ships for it**. There is no partial adapter, no
endpoint and no diagnostic pretending otherwise.

"Experimental" means the opposite of planned and short of supported: the code
ships, it is tested against the protocol's own official artifacts - the A2A SDK,
the ACP schema and examples - and the supported subset is narrow and named
below. Both are off by default.

Every adapter reports itself at runtime through
`GET /.well-known/agent-commerce` and in `agent-commerce doctor`, with
`supportedSpec`, `capabilities`, `unsupported` and `status`. If this page and
that endpoint ever disagree, the endpoint is the truth and this page is a bug.

## MCP

Canonical resources exposed with `expose: [mcp]` become **MCP tools**.

- Tool name = resource id.
- Description = the resource description; for a paid resource the price and the
  payment requirement are appended, so an agent can see the cost before calling.
- Input schema = the canonical `CommerceResource.inputSchema`, property
  descriptions preserved.
- A paid resource's schema carries one extra optional string property,
  `_payment`, documented as the x402 proof returned by a previous
  payment-required response.

### Payment over MCP

MCP has no header channel, so the gateway defines one deterministic
representation, shared with the HTTP surface and the demo buyer through
`toPaymentRequiredEnvelope` in `@devlab.group/agent-commerce`:

```jsonc
// tools/call result when payment is required — isError: true
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
    "accepts": [ /* x402 v2 PaymentRequirements, verbatim */ ],
    "envelope": { /* x402 v2 PaymentRequired, verbatim */ }
  }
}
```

`envelope` is the whole x402 v2 `PaymentRequired` document — the thing an x402
client SDK consumes directly. `accepts` is the same list it contains, kept as a
separate field because it is provider-agnostic. The client signs the offer and
retries the same tool call with `_payment` set to the base64 payment payload;
over HTTP the same value goes in the `PAYMENT-SIGNATURE` header.

Errors map to the same envelope shape with `status: "error"` and a
`CommerceErrorCode`. Stack traces and internal messages never cross the
boundary.

### Not implemented in the MCP adapter

MCP resources, prompts, sampling, notifications, completion, roots, and
server-initiated requests. They are absent, not stubbed. The adapter's
`descriptor.unsupported` lists them at runtime.

The adapter contains **no payment logic** and never calls a merchant backend —
it normalises into `CanonicalRequest` and lets the pipeline decide.

## A2A

**Experimental — A2A v1.0.0.** Off unless `protocols.a2a.enabled` is `true`.

| | |
| --- | --- |
| Binding | JSON-RPC 2.0 over HTTPS |
| JSON-RPC method | `SendMessage` (not the legacy `message/send`) |
| Protocol negotiation version | `1.0`, required in the `A2A-Version` request header |
| Agent Card | `GET /.well-known/agent-card.json` (fixed by the specification) |
| Default mount | `/a2a` |
| Streaming | unsupported |
| Task persistence | unsupported |
| Push notifications | unsupported |

Canonical resources exposed with `expose: [a2a]` become **A2A skills** on the
Agent Card. Skill id = resource id; a paid skill is tagged `paid` and names its
price in the description.

### Invoking a resource

> A2A skills are discovery descriptors. A2A v1.0 does not define a standard
> `skillId` field on `SendMessageRequest`, so Agent Commerce uses the
> structured-data invocation envelope below to select a canonical resource.

One message, one part, whose `data` names the resource and carries its input:

```json
{
  "data": {
    "resource": "market_report",
    "input": {
      "symbol": "ETH"
    }
  },
  "mediaType": "application/json"
}
```

Anything richer is refused rather than guessed at: text, file, inline-bytes and
URL parts, multi-part messages, a role other than `ROLE_USER`, and any task or
context continuation.

> Core A2A v1.0 `AgentSkill` does not provide an input schema field. Canonical
> Agent Commerce `inputSchema` is therefore not embedded in the Agent Card in
> this implementation.

### Payment over A2A

The reserved `_payment` input field, exactly as over MCP — there is no
A2A-specific payment representation:

```json
{
  "data": {
    "resource": "market_report",
    "input": { "symbol": "ETH", "_payment": "<base64 x402 proof>" }
  },
  "mediaType": "application/json"
}
```

### Results

Every outcome is a **terminal task** in the JSON-RPC `result`, carrying one
artifact whose single data part is an existing canonical envelope:

| Outcome | Task state | Artifact data |
| --- | --- | --- |
| delivered | `TASK_STATE_COMPLETED` | the merchant response (a non-object body is wrapped as `{ "value": … }`), with the delivery summary under the artifact's `agent-commerce/delivery` metadata |
| payment required | `TASK_STATE_FAILED` | `toPaymentRequiredEnvelope` output |
| domain failure | `TASK_STATE_FAILED` | `toErrorEnvelope` output |

Payment required is terminal, not `input-required`: there is no task store, so
nothing can be continued. The buyer retries by sending a **new** message
carrying the proof.

A commerce outcome is never a JSON-RPC error. JSON-RPC errors are reserved for
requests that are malformed or unsupported as A2A: `-32700` bad JSON, `-32600`
bad request object, `-32601` unknown method, `-32602` bad params or envelope,
and `-32004` (`UnsupportedOperationError`) for a real A2A operation this
deployment declines — including an unsupported `A2A-Version`.

### Not implemented in the A2A adapter

`SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`,
the four push-notification-config methods, `GetExtendedAgentCard`; the
HTTP+JSON/REST and gRPC bindings; SSE, task persistence and resumption, push
notifications, multi-turn continuation, authenticated extended agent cards, and
A2A authentication schemes. The adapter's `descriptor.unsupported` lists them at
runtime, and `agent-commerce doctor` prints the list in full.

The adapter contains **no payment logic** and never calls a merchant backend.
`@a2a-js/sdk` is a **test-only** dependency: serving A2A installs no SDK.

## ACP

**Experimental — ACP stable snapshot `2026-04-17`.** Off unless
`protocols.acp.enabled` is `true`.

| | |
| --- | --- |
| Binding | REST over HTTPS |
| Pinned snapshot | `2026-04-17`, vendored at `src/protocols/acp/spec/2026-04-17/` |
| Accepted `API-Version` | `2026-04-17`, and only that |
| Discovery | `GET /.well-known/acp.json` (fixed by the specification, public) |
| Default mount | `/acp` |
| Services | `checkout` only |
| Authentication | `Authorization: Bearer <token>`, required on every checkout route |
| Idempotency | `Idempotency-Key` required on every POST, durable, retained >= 24h |

The schema is **vendored, not fetched**: the exact released
`schema.agentic_checkout.json` sits in the repository with its upstream commit
recorded beside it, so a protocol upgrade is an explicit code change with a
diff. Nothing is read from `spec/unreleased`, and nothing is fetched at runtime.

### Required headers

| Header | Where | Rule |
| --- | --- | --- |
| `Authorization` | every checkout route | `Bearer <token>`, compared in constant time |
| `API-Version` | every checkout route | must be `2026-04-17`; missing and unsupported are distinct errors, both naming `supported_versions` |
| `Content-Type` | POST with a body | `application/json` |
| `Idempotency-Key` | every POST | 1-255 printable ASCII characters |
| `Request-Id` | optional | echoed back, bounded and filtered; never used as the gateway's own request id |

A missing or unsupported `API-Version` is never silently mapped to the pinned
one. `latest`, an older snapshot and a typo get the same answer: this deployment
serves one contract.

### The five operations

| ACP operation | Route | Success | Canonical input |
| --- | --- | --- | --- |
| `createCheckoutSession` | `POST {mount}/checkout_sessions` | `201` | `{ body }` |
| `updateCheckoutSession` | `POST {mount}/checkout_sessions/{id}` | `200` | `{ path: { checkout_session_id }, body }` |
| `getCheckoutSession` | `GET {mount}/checkout_sessions/{id}` | `200` | `{ path: { checkout_session_id } }` |
| `completeCheckoutSession` | `POST {mount}/checkout_sessions/{id}/complete` | `200` | `{ path: { checkout_session_id }, body }` |
| `cancelCheckoutSession` | `POST {mount}/checkout_sessions/{id}/cancel` | `200` | `{ path: { checkout_session_id } }`, plus `body` when the caller sends one |

Unlike MCP and A2A, ACP does not expose arbitrary canonical resources: it is a
fixed commerce lifecycle, so each operation names the resource that implements
it, in `protocols.acp.checkout.operations`. A mapped resource must also carry
`expose: [acp]` - the mapping says *which* resource serves the operation, the
exposure says ACP *may* invoke it, and both are required. All five must be
mapped: discovery advertises `checkout` as one service, and a seller announcing
it must be able to serve the whole lifecycle.

The request body is validated against the pinned schema **before** the pipeline
is called, and the merchant's answer is validated against it **before** anything
is returned. A backend that answers with a document that is not an ACP checkout
session, or succeeds on a status ACP does not use for that route, is refused
with a safe `processing_error` - its body is never forwarded and never cached.
Completion has two shapes, chosen by the session's own `status`: a `completed`
session must carry its `order`, while a declined payment or an out-of-stock line
is an ordinary session with no order, exactly as the snapshot's own examples
show.

A working configuration is in [examples/acp-checkout](../examples/acp-checkout).

### ACP payments are not Agent Commerce payments

> ACP `payment_data` belongs to the merchant's checkout and payment flow. It is
> **not** an Agent Commerce `_payment` proof, it is never converted into an x402
> payment, and it reaches the merchant backend unchanged as ordinary business
> input. ACP checkout-operation resources must be **free** at the Agent Commerce
> invocation layer in this release.

Config refuses a paid or `payments:`-carrying checkout resource at load. If the
pipeline somehow answers `payment-required` for an ACP operation anyway, that is
a broken deployment, not something the caller can act on: the adapter logs it
and returns a safe `500`, disclosing nothing about the challenge. ACP has no
wire representation for an Agent Commerce payment challenge, so the alternative
would be inventing one.

### Idempotency

`Idempotency-Key` is mandatory on every ACP POST and is checked before the
request body is even read. A key is scoped by
`(authenticated identity, concrete endpoint path, key)`, where the identity is a
SHA-256 digest of the bearer token - the token itself never reaches the database,
the logs, or a response.

The fingerprint is taken over the **parsed** JSON, so a retry through a
different serializer (different key order, `1.0` where it first sent `1`) is a
retry. Array order, `null` versus an absent property, and type all still
distinguish requests.

| Situation | Answer |
| --- | --- |
| First request | claimed atomically before the merchant is called |
| Same key, same body, still running | `409 idempotency_in_flight` with `Retry-After` |
| Same key, same body, finished | the stored answer, with `Idempotent-Replayed: true`, no merchant call |
| Same key, different body | `422 idempotency_conflict`, no merchant call |
| A `5xx` result | not cached - a clean retry runs again |

Records are kept for at least 24 hours; the configuration floor is the same 24
hours, because a shorter window would let a replayed key past an expired record
and run a checkout twice. Cleanup is lazy, inside the same transaction that
claims a key - there is no background worker.

**The limit, stated plainly.** A merchant side effect over HTTP and a local
SQLite commit are not one transaction. Ordinary retries and concurrency are
protected durably, but if the process dies after the merchant completed an order
and before the answer was stored, that key stays claimed and every retry is
answered `409` until it expires - deliberately, because re-running a completion
whose remote state is unknown risks charging a buyer twice. This is not
exactly-once semantics across a remote system, and it is not claimed to be:
merchant-side idempotency on destructive operations is still recommended.

### Errors

Errors are ACP `Error` documents - `type`, `code`, `message`, and `param` only
where a safe pointer into the *caller's own* document exists. The merchant's
response body is never forwarded, and neither is a stack trace, a database
error, a filesystem path, a schema internal or the bearer token.

| Cause | ACP answer |
| --- | --- |
| Merchant 404 | `404 checkout_session_not_found` |
| Merchant 405 on cancel | `405 checkout_session_not_cancelable` |
| Merchant 400 / 422 | `422 invalid_request_body` |
| Merchant 409 | `409 checkout_session_conflict` |
| Merchant 401 / 403 / 5xx / anything else | `502 processing_error` |
| Backend timeout | `504 service_unavailable` |
| Gateway load shedding | `503 service_unavailable` |
| Broken mapping, storage failure, payment-required | `500 processing_error` |

A merchant `401` or `403` is deliberately not relayed: it would tell the agent
its own bearer token failed, when what failed is the gateway's credential with
the backend.

### Discovery

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

Public, unauthenticated, `Cache-Control: public, max-age=3600`, and served only
while ACP is enabled. `services` lists `checkout` alone because that is all this
adapter implements - ACP lets a seller advertise only what it serves, which is
what makes an honest partial implementation possible. `transports` lists `rest`
alone: ACP's MCP transport is a *separate ACP-specific binding* with fixed
checkout tools, and is not the generic MCP adapter this gateway also serves.

Optional metadata (`documentation_url`, `supported_currencies`,
`supported_locales`, `intervention_types`) appears only when configured, and is
never inferred - in particular never from the x402 payment configuration, which
is a different payment domain. The document is validated against the pinned
schema when the adapter starts, so a misconfigured value fails the adapter
rather than publishing a non-conformant document. Nothing derived from
configuration secrets appears: no token, no backend URL, no resource ids, no
idempotency database path.

### Not implemented in the ACP adapter

The carts, feed and standalone orders services; `delegate_payment` and
`delegate_authentication`; the ACP MCP transport binding; webhooks and any
outbound merchant-to-agent delivery; the ACP client role; request `Signature`
verification and `Timestamp` replay-window verification; the discount extension
and the general extension framework; seller-backed payment handler integration;
and any ACP API version other than `2026-04-17`.

A `Signature` header is never accepted in place of the bearer token. The
adapter's `descriptor.unsupported` lists all of this at runtime, and
`agent-commerce doctor` prints it in full.

The adapter contains **no payment logic** and never calls a merchant backend
directly. No ACP SDK ships: `@agentclientprotocol/sdk` is the unrelated *Agent
Client Protocol* and is not used here - the conformance suite runs against the
official ACP schema and examples.

## x402

- Scheme `exact`, EVM family, via EIP-3009 `transferWithAuthorization`.
- The gateway builds `PaymentRequirements` with `extra: { name, version }` set
  explicitly so the EIP-712 domain is unambiguous.
- Verification checks scheme, signature, recipient, amount, validity window,
  payer balance, network and asset. The gateway additionally binds a
  `replayKey` and reserves it before settling.
- Settlement broadcasts the authorisation and waits for the receipt; the
  transaction hash becomes `PaymentResult.externalReference` and lands in the
  receipt.

### Not implemented

Solana/SVM, the `deferred` scheme, Permit2, multi-asset routing and dynamic
pricing.

Facilitator auth covers `none`, `bearer` and `cdp`; any other scheme is refused
at config load rather than sent nothing.

A remote HTTP facilitator **is** supported (`facilitator.mode: remote`), and
so are Base Sepolia and Base mainnet — both have settled real payments through
one. What guards mainnet is in [configuration.md](configuration.md).

## HTTP surface

| Route                                  | Purpose                                                                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                          | liveness                                                                                                                |
| `GET /ready`                           | readiness — config, store, required adapters and configured payment providers                                           |
| `GET /.well-known/agent-commerce`      | merchant info, adapter descriptors, pinned versions, effective settlement destination                                   |
| `GET /api/resources`                   | canonical resource list                                                                                                 |
| `POST /api/resources/:id/invoke`       | invoke; `PAYMENT-SIGNATURE` in, `402` + body envelope and `PAYMENT-REQUIRED` header when unpaid, `PAYMENT-RESPONSE` out |
| `GET /api/receipts`, `GET /api/events` | audit                                                                                                                   |
| `GET /api/events/stream`               | SSE event feed                                                                                                          |
| `/mcp`                                 | MCP Streamable HTTP                                                                                                     |
| `/.well-known/agent-card.json`         | A2A Agent Card (only when A2A is enabled)                                                                               |
| `/a2a`                                 | A2A JSON-RPC `SendMessage` (only when A2A is enabled)                                                                   |
| `/.well-known/acp.json`                | ACP seller discovery (only when ACP is enabled)                                                                         |
| `/acp/checkout_sessions…`              | ACP checkout, bearer-authenticated (only when ACP is enabled)                                                           |

## Adding a protocol

See [contributing-adapters.md](contributing-adapters.md). The short version: a
new protocol is a new `ProtocolAdapter`, and it must not require a change to
`src/core`. If it does, that is a design conversation before it is a PR.
