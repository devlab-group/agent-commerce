# Protocol support

Alpha honesty is a release requirement: this page states exactly what is
implemented, exactly what is not, and pins the revisions.

## Support matrix

| Protocol | Status    | Revision                                                                             | What works                                                          |
| -------- | --------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| **MCP**  | Supported | `@modelcontextprotocol/sdk@1.30.0`                                                   | tool discovery, tool invocation, payment-required and error mapping |
| **x402** | Supported | x402 **v2** (`@x402/core@2.23.0`, `@x402/evm@2.23.0`), scheme `exact`, EVM, EIP-3009 | challenge, verification, settlement, replay binding                 |
| **HTTP** | Supported | -                                                                                    | native resource routes, payment headers per rail                    |
| **A2A**  | Experimental | A2A **v1.0.0**, negotiation version `1.0`, binding `JSONRPC`                     | Agent Card discovery, `SendMessage`, terminal tasks, paid flow      |
| **ACP**  | Experimental | ACP stable snapshot **2026-04-17**, REST binding                                 | discovery, the five checkout operations, bearer auth, idempotency   |
| **AP2**  | Experimental | AP2 **v0.2.0**, tagged 2026-04-28, commit `b4587ac`, Direct mode               | closed Checkout Mandate verification before settlement                         |
| UCP      | Planned   | —                                                                                    | planned, no code ships                                                         |
| **MPP**  | Experimental | MPP drafts at `tempoxyz/mpp-specs@806fdb8`, `mppx@0.10.1`, `charge`/`evm`/EIP-3009 | challenge, verification, settlement, HTTP/MCP/A2A carriers |

"Planned" means **no code ships for it**. There is no partial adapter, no
endpoint and no diagnostic pretending otherwise.

"Experimental" means the code ships but is off by default and supports only the
subset named below.

AP2 is listed here because this is where people look, but it is not a
transport and has no adapter, no mount path and no discovery document. It is an
authorization method: it decides whether a payment is allowed to settle, and a
resource that requires one still needs a real payment proof. It has its own
page, [ap2.md](ap2.md), and `doctor` reports it separately from the protocols.

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
  `_payment`, for the proof of the resource's first payment method.

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

For an MPP resource, `provider` is `mpp`, `accepts` holds the MPP challenge,
and `envelope.wwwAuthenticate` is that challenge as a `WWW-Authenticate` value.
The client retries with `_payment` set to its credential, the full
`Authorization: Payment ...` value.

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
| Idempotency | `Idempotency-Key` required on every POST, durable, retained >= 24h, forwarded to the merchant |

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
`(deployment, concrete endpoint path, key)`, where the deployment is the
gateway's own public base URL. Deliberately **not** the bearer token or a
digest of it: a claim must survive a credential rotation, and scoping by the
token meant a rotated one found no row, reserved afresh, and re-ran an
operation whose outcome might already be unknown. The token plays no part in
idempotency and never reaches the database, the logs, or a response.

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
| Merchant answered, even to refuse (`4xx`) | cached; the refusal is the answer to every retry |
| Merchant reached, outcome unknown (timeout, `5xx`, unreadable reply) | `409 idempotency_unresolved`, no `Retry-After`, the merchant is not called again |
| Failed before the merchant was called | not cached - a clean retry runs |

Completed records are kept for at least 24 hours; the configuration floor is the
same 24 hours, because a shorter window would let a replayed key past an expired
record and run a checkout twice. Cleanup is lazy, inside the same transaction
that claims a key - there is no background worker.

**An unresolved record never expires.** A timeout or a merchant `5xx` is not
evidence that the merchant did nothing: it may have created the order and lost
the response. Freeing the key would hand the next retry a clean slate and place
the second order, so the claim is kept and the caller is told the outcome is
unknown rather than invited to retry. Sweeping such a row on a timer would
re-create that same bug, so retention only ever deletes a completed one.
Clearing an unresolved record is an operator's decision, taken against the
merchant's own records.

### What the merchant must implement

The gateway forwards an **`Idempotency-Key` request header** on every call it
makes for a side-effecting ACP operation. It is not the caller's key but a
SHA-256 digest over `(deployment, endpoint, caller key)`, so it is

- **identical** across a client retry, a network-level retry, a gateway restart
  and a credential rotation, which is what makes it usable as the name of an
  operation;
- **different** for the same key used on two endpoints, and for two gateways
  fronting the same backend;
- **opaque** - it carries back neither the caller's key nor anything about the
  gateway.

A merchant should key its own record of a side-effecting operation on that
value: if a request arrives under a key it has already completed, return the
original result rather than performing the operation again. It also needs some
way to look an operation up by that key, because that is what an operator uses
to resolve an unresolved record.

**If the merchant does not implement it**, everything above still holds for
retries the gateway sees - the claim is durable and concurrency-safe, and no
ambiguous failure ever frees one. What weakens is the case the gateway cannot
see: a request that reached the merchant twice by some path outside it, such as
a proxy retry or a duplicate delivery, which only the merchant can collapse.

**The limit, stated plainly.** A merchant side effect over HTTP and a local
SQLite commit are not one transaction. Ordinary retries and concurrency are
protected durably, but if the process dies after the merchant completed an order
and before the answer was stored, that key stays claimed and every retry is
refused - deliberately, because re-running a completion whose remote state is
unknown risks charging a buyer twice. This is not exactly-once semantics across
a remote system, and it is not claimed to be: merchant-side idempotency on
destructive operations is still recommended.

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

## MPP

**Experimental - drafts at `tempoxyz/mpp-specs@806fdb8`, `mppx@0.10.1`.** Off
unless `payments.mpp.enabled` is `true`.

- The `charge` intent, the `evm` method and the EIP-3009 `authorization`
  credential, in USDC on `eip155:84532` or Base mainnet `eip155:8453`.
- Gateway config for mainnet requires the guardrails in
  [configuration.md](configuration.md#mainnet-guardrails).
- Settlement goes through an x402 facilitator; see
  [configuration.md](configuration.md).
- Carriers are in [Payment over MCP](#payment-over-mcp) and the
  [HTTP surface](#http-surface) header table.

The unsupported list lives in `src/payments/mpp/descriptor.ts`. When MPP is
enabled, `/.well-known/agent-commerce` publishes it with the MPP descriptor.

## HTTP surface

| Route                                  | Purpose                                                                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                          | liveness                                                                                                                |
| `GET /ready`                           | readiness — config, store, required adapters and configured payment providers                                           |
| `GET /.well-known/agent-commerce`      | merchant info, adapter descriptors, pinned versions, effective settlement destination                                   |
| `GET /api/resources`                   | canonical resource list                                                                                                 |
| `POST /api/resources/:id/invoke`       | invoke; `402` + body envelope when unpaid, with the payment headers below                                               |
| `GET /api/receipts`, `GET /api/events` | audit                                                                                                                   |
| `GET /api/events/stream`               | SSE event feed                                                                                                          |
| `/mcp`                                 | MCP Streamable HTTP                                                                                                     |
| `/.well-known/agent-card.json`         | A2A Agent Card (only when A2A is enabled)                                                                               |
| `/a2a`                                 | A2A JSON-RPC `SendMessage` (only when A2A is enabled)                                                                   |
| `/.well-known/acp.json`                | ACP seller discovery (only when ACP is enabled)                                                                         |
| `/acp/checkout_sessions…`              | ACP checkout, bearer-authenticated (only when ACP is enabled)                                                           |

The invoke route uses the headers of the resource's first payment method:

| Method | Proof                        | Challenge on `402`              | On delivery                              |
| ------ | ---------------------------- | ------------------------------- | ---------------------------------------- |
| x402   | `PAYMENT-SIGNATURE`          | `PAYMENT-REQUIRED`              | `PAYMENT-RESPONSE`                       |
| MPP    | `Authorization: Payment ...` | `WWW-Authenticate: Payment ...` | `Payment-Receipt` and `PAYMENT-RESPONSE` |

`PAYMENT-RESPONSE` is also sent when the backend fails after settlement.

## Adding a protocol

See [contributing-adapters.md](contributing-adapters.md). The short version: a
new protocol is a new `ProtocolAdapter`, and it must not require a change to
`src/core`. If it does, that is a design conversation before it is a PR.
