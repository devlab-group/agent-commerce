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
| UCP      | Planned   | —                                                                                    | planned, no code ships                                                         |
| ACP      | Planned   | —                                                                                    | planned, no code ships                                                         |
| MPP      | Planned   | —                                                                                    | planned, no code ships                                                         |
| AP2      | Planned   | —                                                                                    | planned, no code ships                                                         |

"Planned" means **no code ships for it**. There is no partial adapter, no
endpoint and no diagnostic pretending otherwise.

"Experimental" means the opposite of planned and short of supported: the code
ships, it is tested against the official SDK, and the supported subset is
narrow and named below. It is off by default.

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

## Adding a protocol

See [contributing-adapters.md](contributing-adapters.md). The short version: a
new protocol is a new `ProtocolAdapter`, and it must not require a change to
`src/core`. If it does, that is a design conversation before it is a PR.
