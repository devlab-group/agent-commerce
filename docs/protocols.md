# Protocol support

Alpha honesty is a release requirement: this page states exactly what is
implemented, exactly what is not, and pins the revisions.

## Support matrix

| Protocol | Status    | Revision                                                                             | What works                                                          |
| -------- | --------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| **MCP**  | Supported | `@modelcontextprotocol/sdk@1.30.0`                                                   | tool discovery, tool invocation, payment-required and error mapping |
| **x402** | Supported | x402 **v2** (`@x402/core@2.23.0`, `@x402/evm@2.23.0`), scheme `exact`, EVM, EIP-3009 | challenge, verification, settlement, replay binding                 |
| **HTTP** | Supported | —                                                                                    | native resource routes with `PAYMENT-SIGNATURE`                     |
| UCP      | Planned   | —                                                                                    | planned, no code ships                                                         |
| ACP      | Planned   | —                                                                                    | planned, no code ships                                                         |
| MPP      | Planned   | —                                                                                    | planned, no code ships                                                         |
| A2A      | Planned   | —                                                                                    | planned, no code ships                                                         |
| AP2      | Planned   | —                                                                                    | planned, no code ships                                                         |

"Planned" means **no code ships for it**. There is no partial adapter, no
endpoint and no diagnostic pretending otherwise.

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

## Adding a protocol

See [contributing-adapters.md](contributing-adapters.md). The short version: a
new protocol is a new `ProtocolAdapter`, and it must not require a change to
`src/core`. If it does, that is a design conversation before it is a PR.
