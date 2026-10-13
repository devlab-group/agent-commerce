# Protocol support

This page lists each protocol's status, pinned revision and implemented
subset. Each protocol's page describes that subset in detail.

## Support matrix

| Protocol | Status       | Revision                                                                                  | Implemented subset                                                                                                                                                    |
| -------- | ------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HTTP** | Supported    | native                                                                                    | resource routes and rail-specific payment headers                                                                                                                     |
| **MCP**  | Supported    | MCP `2026-07-28` and `2025-11-25` through `@modelcontextprotocol/server@2.3.0`            | tool discovery, invocation, payment-required and error mapping                                                                                                        |
| **x402** | Supported    | x402 v2, `@x402/core@2.25.0`, `@x402/evm@2.25.0`, `@x402/svm@2.25.0`, `@x402/near@2.25.0` | `exact` on EVM through EIP-3009 or Permit2, on Solana, and on NEAR (partial): challenge, verification, settlement and replay binding; Nano send blocks (experimental) |
| **A2A**  | Experimental | v1.0.1; negotiation `1.0`; `JSONRPC` binding                                              | Agent Card, `SendMessage`, paid flow and the x402 extension                                                                                                           |
| **ACP**  | Experimental | stable snapshot `2026-04-17`; REST binding                                                | discovery and the five checkout operations                                                                                                                            |
| **AP2**  | Experimental | v0.2.0, tag 2026-04-28, commit `b4587ac`; Direct mode                                     | closed Checkout Mandate verification before settlement                                                                                                                |
| **MPP**  | Experimental | drafts at `tempoxyz/mpp-specs@806fdb8`; `mppx@0.13.1`                                     | `charge`/`evm`/EIP-3009 over HTTP, MCP and A2A                                                                                                                        |
| UCP      | Planned      | -                                                                                         | no implementation                                                                                                                                                     |

Experimental components are disabled unless configured and support only the
subsets their pages describe. Planned means there is no adapter or endpoint.

AP2 is an authorization method, not a transport or payment rail. It appears in
`authorizationProviders` in gateway discovery and has no AP2-specific mount or
discovery endpoint. See [AP2](protocols/ap2.md).

An AP2-gated resource still requires its configured payment proof. A mandate
authorizes the purchase but does not settle it.

`GET /.well-known/agent-commerce` reports descriptors for registered adapters
and providers, including `supportedSpec`, `capabilities`, `unsupported` and
`status`. When enabled, A2A, ACP and AP2 also print their detailed unsupported
lists in `agent-commerce doctor`.

## Protocol pages

- [HTTP surface](protocols/http.md): routes, and the payment headers each rail
  uses on the invoke route
- [MCP](protocols/mcp.md): tools, payment over MCP, and exclusions
- [A2A](protocols/a2a.md): invocation and payment, the x402 extension, results,
  and exclusions
- [ACP](protocols/acp.md): headers, checkout operations, the payment boundary,
  idempotency, errors, discovery, and exclusions
- [x402](protocols/x402.md): the `exact` scheme on EVM, Solana and NEAR, Nano (experimental),
  several options, payment flows, and mainnet guardrails
- [MPP](protocols/mpp.md): the pinned drafts, the `charge` profile, payment
  flow, problem documents, and exclusions
- [AP2](protocols/ap2.md): mandate verification before a paid resource settles

## Adding an integration

See [contributing-adapters.md](contributing-adapters.md). Adapter and provider
implementations keep protocol-specific logic outside `src/core`; new protocol
or rail names require an approved frozen-contract change.
