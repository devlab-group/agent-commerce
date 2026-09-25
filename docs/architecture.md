# Architecture

## The problem

Merchants already have HTTP APIs. The gateway adds agent discovery, invocation
and payment protocols without moving that logic into every backend or routing
funds through a hosted intermediary.

## The shape of the answer

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                                   AI Agent                                   │
└───────────────────────────────────────┬──────────────────────────────────────┘
                                        │  MCP (tools/list, tools/call) · A2A · ACP · HTTP
                                        │  payment proof · Agent-Authorization
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
│           (ap2)             (x402, mpp)     (bounded HTTP)      (SQLite)     │
└───────────────────────────────────────┬──────────────────────────────────────┘
                                        │
                           ┌────────────▼───────────┐
                           │  Merchant Backend API  │
                           └────────────────────────┘

payment protocol: buyer → merchant, directly. Never through the gateway.
```

Three properties define the design:

- **Self-hosted.** The gateway runs in the merchant's infrastructure. There is
  no central service operated by this project, and none is planned.
- **Non-custodial.** The gateway never holds merchant or buyer funds or keys.
  Local facilitator mode keeps a gas-paying signer in the gateway process.
  Mainnet requires a remote facilitator. Config accepts local mode on Base
  Sepolia with a non-Anvil key, but its health check requires Anvil, so use
  remote mode for public Base Sepolia. See [Security model](security.md).
- **Configuration, not rewriting.** A merchant describes an existing endpoint
  in `config.yaml`. `agent-commerce import openapi` can generate draft resource
  definitions:

  ```text
  OpenAPI -> importer -> resource definitions -> canonical model -> pipeline
  ```

  The importer stops at the config boundary. Runtime code does not read the
  OpenAPI document or use OpenAPI-specific core types, so imported and
  hand-written resources follow the same path. See
  [OpenAPI import](openapi-import.md).

## Canonical model before protocol adapters

The core defines protocol-neutral commerce operations. It uses stable method
names such as `x402` and `mpp` for selection, but imports no MCP, JSON-RPC,
x402 SDK, EIP-712 or EVM wire types. Its main concepts are:

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

Adapters and providers own protocol- and rail-specific representations.
Provider-native challenges pass through the core as opaque
`Record<string, unknown>` values in `PaymentRequirement.challenge.accepts`.

New protocols map to the canonical model at their boundary instead of changing
the pipeline. See [Adapter guide](contributing-adapters.md).

## The execution pipeline

Every adapter uses this pipeline, so each surface gets the same validation,
authorization, payment and receipt behavior.

```text
CanonicalRequest
  │
  ├─ resolve resource ─────────────────────► RESOURCE_NOT_FOUND
  ├─ validate input ───────────────────────► INPUT_INVALID
  ├─ resolve price
  │
  ├─ free ───────────────────────────────────────────────────┐
  └─ paid                                                    │
       ├─ create requirement                                 │
       ├─ no proof ─────────────► PaymentRequiredOutcome     │
       ├─ verify rejected ────────────► PAYMENT_INVALID      │
       ├─ replayKey missing ──────────► PAYMENT_INVALID      │
       ├─ authorize + reserve ────────► AUTHORIZATION_*      │
       ├─ reserve replayKey ──────────► PAYMENT_REPLAYED     │
       ├─ settle ───────────► PAYMENT_SETTLEMENT_FAILED      │
       └─ consume, release or mark authorization             │
                                                             │
  ┌──────────────────────────────────────────────────────────┘
  ├─ call merchant backend ────────────────► BACKEND_TIMEOUT / BACKEND_ERROR
  ├─ store receipt + events ───────────────► STORAGE_ERROR
  └─ ExecutionOutcome (delivered)
```

`verify` never moves money; only `settle` does. The replay reservation sits
deliberately **between** them: a duplicate authorisation is rejected before any
funds move.

Authorization is optional per resource. When required, its reservation sits
between payment verification and settlement and is released only when a
failure proves that no money moved. See
[ap2.md](ap2.md#pipeline-position).

## Correlation

The protocol adapter assigns one `requestId`. The pipeline carries it through
errors, events, payment attempts and the receipt, linking the audit records for
one invocation.

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

An adapter that fails to start is marked unhealthy without stopping other
adapters. Readiness and `doctor` report the failure. Protocol and payment
failures remain separate.

## Receipts and audit

SQLite stores `receipts`, `events` and `payment_attempts` behind `ReceiptStore`.
A `UNIQUE` constraint on `payment_attempts.replay_key` makes replay reservation
atomic. The pipeline omits raw payment proofs, and SQLite row mapping redacts
recognized secret fields before persistence.

## Deterministic by construction

LLMs may call the gateway but are not runtime dependencies. Routing,
validation, payment verification, receipts and protocol adaptation are
deterministic. CI uses a deterministic buyer and local chain, without a model,
public RPC or real funds.

## Where to look in the code

| Concern                                              | Path                           |
| ---------------------------------------------------- | ------------------------------ |
| canonical model, errors, pipeline                    | `src/core`                     |
| config schema, loader, env substitution              | `src/config`                   |
| Fastify server, routes, adapter mounting             | `src/gateway`                  |
| MCP adapter                                          | `src/protocols/mcp`            |
| x402 provider + local/remote facilitator             | `src/payments/x402`            |
| MPP provider, settling through an x402 provider      | `src/payments/mpp`             |
| AP2 mandate verification                             | `src/authorization/ap2`        |
| SQLite receipts/events/attempts                      | `src/storage/receipts`         |
| OpenAPI import (config ingress only)                 | `src/openapi`                  |
| CLI (`init`, `import`, `validate`, `doctor`, `demo`) | `src/cli`                      |
| demo merchant API / buyer / dashboard                | `demo/*`                       |
| MockUSDC + local chain scripts                       | `contracts/`, `scripts/chain/` |
