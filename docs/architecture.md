# Architecture

## The problem

A merchant already has an HTTP API. AI agents are learning to discover, invoke
and pay for capabilities through a growing set of protocols - MCP, x402, and
several more arriving. Implementing each one inside every merchant backend does
not scale, and handing the money to a proprietary middleman defeats the point.

## The shape of the answer

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                                   AI Agent                                   │
└───────────────────────────────────────┬──────────────────────────────────────┘
                                        │  MCP (tools/list, tools/call) · A2A · ACP · HTTP
                                        │  PAYMENT-SIGNATURE · Agent-Authorization
┌───────────────────────────────────────▼──────────────────────────────────────┐
│                            Agent Commerce Gateway                            │
│                      (runs in MERCHANT infrastructure)                       │
│                                                                              │
│                  protocol adapters: mcp · http · a2a · acp                   │
│                                      │                                       │
│                                      ▼                                       │
│                              ExecutionPipeline                               │
│                                      │                                       │
│             ┌────────────────────┬───┴─────────────┬────────────────┐        │
│             ▼                    ▼                 ▼                ▼        │
│   AuthorizationProvider   PaymentProvider   BackendExecutor   ReceiptStore   │
│           (ap2)               (x402)        (bounded HTTP)      (SQLite)     │
└───────────────────────────────────────┬──────────────────────────────────────┘
                                        │
                           ┌────────────▼───────────┐
                           │  Merchant Backend API  │
                           └────────────────────────┘

payment protocol: buyer → merchant, directly. Never through the gateway.
```

Three properties are load-bearing:

- **Self-hosted.** The gateway runs in the merchant's infrastructure. There is
  no central service operated by this project, and none is planned.
- **Non-custodial.** The gateway orchestrates a payment protocol; it never holds
  funds or keys. See [security.md](security.md).
- **Configuration, not rewriting.** A merchant exposes an existing endpoint by
  describing it in `config.yaml`. If they already have an OpenAPI description,
  `agent-commerce import openapi` writes that configuration for them - an
  ingress tool, not a second runtime:

  ```text
  OpenAPI -> importer -> resource definitions -> canonical model -> pipeline
  ```

  and never:

  ```text
  OpenAPI -> a separate runtime executor
  ```

  The importer terminates at the config boundary. No OpenAPI type exists in
  `src/core`, nothing reads the document after import, and an imported resource
  is indistinguishable at runtime from one typed by hand. See
  [openapi-import.md](openapi-import.md).

## Canonical model before protocol adapters

The core knows nothing about MCP, JSON-RPC, x402, EIP-712 or EVM. It knows:

| Concept                                              | Type                 |
| ---------------------------------------------------- | -------------------- |
| a thing an agent can invoke                          | `CommerceResource`   |
| what it costs                                        | `Pricing`            |
| how to reach the merchant backend                    | `BackendHandler`     |
| one inbound call                                     | `CanonicalRequest`   |
| what must be paid, and the opaque provider challenge | `PaymentRequirement` |
| what happened to a payment                           | `PaymentResult`      |
| proof of delivery                                    | `CommerceReceipt`    |
| everything worth observing                           | `CommerceEvent`      |

Protocol- and rail-specific representations exist **only** at adapter
boundaries. Provider-native payment challenges ride through the core as opaque
`Record<string, unknown>` inside `PaymentRequirement.challenge.accepts`; core
passes them through and never inspects them.

Why this matters: adding ACP, AP2, A2A or a second payment rail becomes one new
adapter rather than a core rewrite - and semantics from one protocol cannot leak
into another. See [contributing-adapters.md](contributing-adapters.md).

## The execution pipeline

Every adapter converges here. Nothing bypasses it - that is what makes payment
enforcement a property of the system rather than of each adapter.

```text
CanonicalRequest
  │
  ├─ resolve resource ─────────────────────► RESOURCE_NOT_FOUND
  ├─ validate input ───────────────────────► INPUT_INVALID
  ├─ resolve price
  │
  ├─ free ──────────────────────────────────────────────┐
  │ │
  └─ paid │
       ├─ createRequirement │
       ├─ no proof ──► PaymentRequiredOutcome (402) ─────┤ fail closed
       ├─ verify ──► rejected ► PAYMENT_INVALID ──────┤
       ├─ replayKey missing ────► PAYMENT_INVALID ───────┤
       ├─ authorize + reserve ──► AUTHORIZATION_* ───────┤
       ├─ reserve replayKey ────► PAYMENT_REPLAYED ──────┤
       ├─ settle ─────────────► PAYMENT_SETTLEMENT_FAILED
       └─ consume | release | mark the authorization
                                                          │
  ┌───────────────────────────────────────────────────────┘
  ├─ call merchant backend ────────────────► BACKEND_TIMEOUT / BACKEND_ERROR
  ├─ store receipt + events ───────────────► STORAGE_ERROR
  └─ ExecutionOutcome (delivered)
```

`verify` never moves money; only `settle` does. The replay reservation sits
deliberately **between** them: a duplicate authorisation is rejected before any
funds move.

The authorization step is opt-in per resource and absent from almost every
deployment. Where a resource does require one, it sits between payment
verification and settlement for the same reason the replay reservation does,
and only a failure that provably moved no money hands it back. See
[ap2.md](ap2.md#where-it-sits).

## Correlation

Every flow has one `requestId`, generated by the protocol adapter and carried
through every log line, event, payment attempt and receipt. That single id is
what makes a live demo - and a post-incident investigation - legible.

Event sequence for a successful paid request:

```text
resource.requested → payment.required → payment.verified → payment.settled
                   → backend.called → resource.delivered
```

A resource requiring authorization adds `authorization.verified` (or
`authorization.rejected`) between the request and the payment events. The event
types are the same whatever the method, so reading the audit trail never
requires knowing what AP2 is.

## Adapter isolation

An optional adapter that fails to start is marked unhealthy and reported by
`doctor`; it does not stop the process or affect the others. A protocol failure
must never become a payment failure, and vice versa.

## Receipts and audit

SQLite, three tables - `receipts`, `events`, `payment_attempts` - behind a thin
repository. `payment_attempts.replay_key` carries a `UNIQUE` constraint, which
is what makes the replay defence atomic rather than advisory. No secrets and no
raw payment proofs are persisted.

## Deterministic by construction

LLMs are optional *clients* of this system, never dependencies of it. Routing,
validation, payment verification, receipts and protocol adaptation are
deterministic and testable without a model, a public RPC or real money. The
demo buyer agent is a deterministic program, and that is the path CI runs.

## Where to look in the code

| Concern                                              | Path                           |
| ---------------------------------------------------- | ------------------------------ |
| canonical model, errors, pipeline                    | `src/core`                     |
| config schema, loader, env substitution              | `src/config`                   |
| Fastify server, routes, adapter mounting             | `src/gateway`                  |
| MCP adapter                                          | `src/protocols/mcp`            |
| x402 provider + local/remote facilitator             | `src/payments/x402`            |
| AP2 mandate verification                             | `src/authorization/ap2`        |
| SQLite receipts/events/attempts                      | `src/storage/receipts`         |
| OpenAPI import (config ingress only)                 | `src/openapi`                  |
| CLI (`init`, `import`, `validate`, `doctor`, `demo`) | `src/cli`                      |
| demo merchant API / buyer / dashboard                | `demo/*`                       |
| MockUSDC + local chain scripts                       | `contracts/`, `scripts/chain/` |
