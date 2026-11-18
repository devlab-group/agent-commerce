# Protocol support

This page lists each protocol's status, pinned revision and implemented
subset. Each protocol's page describes that subset in detail.

## Support matrix

<!-- support-record:begin matrix -->

| Protocol     | Status       | Role                                                                                                                                                                              | Revision                                                                                                          | Implemented subset                                                                                                                   |
| ------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **HTTP**     | Supported    | Transport that carries x402 and MPP payments on each resource's invoke route.                                                                                                     | native                                                                                                            | resource routes and rail-specific payment headers                                                                                    |
| **MCP**      | Supported    | Transport that carries x402 and MPP payments in tool calls.                                                                                                                       | MCP `2026-07-28` and `2025-11-25`; `@modelcontextprotocol/server@2.3.0`                                           | tool discovery, invocation, payment-required and error mapping                                                                       |
| **x402**     | Supported    | Payment rail, carried by HTTP, MCP and A2A.                                                                                                                                       | x402 v2; `@x402/core@2.30.0`, `@x402/evm@2.30.0`, `@x402/svm@2.30.0`, `@x402/near@2.30.0`                         | `exact` on EVM through EIP-3009 or Permit2, on Solana, and on NEAR (partial): challenge, verification, settlement and replay binding |
| **MPP**      | Experimental | Payment rail, carried by HTTP, MCP and A2A.                                                                                                                                       | drafts at `tempoxyz/mpp-specs@806fdb8`; `mppx@0.13.1`                                                             | `charge`/`evm`/EIP-3009 with USDC on Base Sepolia and Base, over HTTP, MCP and A2A                                                   |
| **A2A**      | Experimental | Transport that carries x402 and MPP payments in `SendMessage`, including through the x402 extension.                                                                              | v1.0.1; negotiation `1.0`; `JSONRPC` binding                                                                      | Agent Card, `SendMessage`, paid flow and the x402 extension                                                                          |
| **ACP**      | Experimental | Checkout API that forwards checkout operations to the merchant, whose payment handler receives `payment_data`. Gateway checkout routes are free and carry no x402 or MPP payment. | stable snapshot `2026-04-17`; REST binding                                                                        | discovery and the five checkout operations                                                                                           |
| **AP2**      | Experimental | Authorization method, not a payment rail: a paid resource can require a verified mandate in addition to its x402 or MPP payment, never instead of it.                             | v0.2.0, tag 2026-04-28, commit `b4587ac`; Direct mode; `jose@6.2.12`, `@sd-jwt/core@0.20.1`, `canonicalize@5.0.0` | closed Checkout Mandate verification before settlement                                                                               |
| **ERC-8409** | Experimental | x402 feature: EIP-712 signed quotes on the EVM offers of a challenge.                                                                                                             | draft `SergeevDmitry/ERCs@0ee33230`                                                                               | signed quotes on x402 EVM offers; issuer published in `/.well-known/agent-commerce`                                                  |

<!-- support-record:end -->

Experimental components are disabled unless configured and support only the
subsets their pages describe. UCP is planned and has no implementation.

AP2 is an authorization method, not a transport or payment rail. It appears in
`authorizationProviders` in gateway discovery and has no AP2-specific mount or
discovery endpoint. See [AP2](protocols/ap2.md).

An AP2-gated resource still requires its configured payment proof. A mandate
authorizes the purchase but does not settle it.

`GET /.well-known/agent-commerce` reports descriptors for registered adapters
and providers, including `supportedSpec`, `capabilities`, `unsupported` and
`status`. When enabled, A2A, ACP and AP2 also print their detailed unsupported
lists in `agent-commerce doctor`.

## Tested combinations

Each row names the test that covers a rail over a surface. E2E rows settle on
a local Anvil chain. Integration rows mock the facilitator and run no chain.
Public testnet and mainnet rows are smoke tests that spend funds and run only
on the wallet holder's machine, never in CI.

<!-- support-record:begin combinations -->

| Rail | Surface | Authorization | Tested at             | Test                                             |
| ---- | ------- | ------------- | --------------------- | ------------------------------------------------ |
| x402 | HTTP    | -             | E2E, local chain      | `tests/e2e/payment/x402-settlement.e2e.test.ts`  |
| x402 | A2A     | -             | E2E, local chain      | `tests/e2e/payment/x402-settlement.e2e.test.ts`  |
| x402 | HTTP    | AP2           | E2E, local chain      | `tests/e2e/authorization/ap2-x402.e2e.test.ts`   |
| x402 | MCP     | -             | integration, no chain | `tests/integration/mcp-payment-bindings.test.ts` |
| x402 | HTTP    | -             | public testnet        | `tests/testnet/x402.smoke.test.ts`               |
| x402 | HTTP    | -             | mainnet               | `tests/mainnet/x402.smoke.test.ts`               |
| MPP  | HTTP    | -             | E2E, local chain      | `tests/e2e/payment/mpp-settlement.e2e.test.ts`   |
| MPP  | HTTP    | AP2           | E2E, local chain      | `tests/e2e/authorization/ap2-mpp.e2e.test.ts`    |
| MPP  | MCP     | -             | integration, no chain | `tests/integration/mcp-payment-bindings.test.ts` |
| MPP  | A2A     | -             | integration, no chain | `tests/integration/mpp-carriers.test.ts`         |
| MPP  | HTTP    | -             | public testnet        | `tests/testnet/mpp-base-sepolia.smoke.test.ts`   |
| MPP  | HTTP    | -             | mainnet               | `tests/mainnet/mpp-base.smoke.test.ts`           |

<!-- support-record:end -->

## Promotion criteria

A profile moves from experimental to supported when all four criteria hold.
Each reads fields of the profile's record in `src/support/`:

1. Upstream declares the pinned revision stable (`spec.stable`).
2. Every MUST-level gap against that revision is closed, or the profile
   excludes the feature and lists it (`gaps`, `exclusions`).
3. Conformance evidence exists: the upstream suite where there is one,
   otherwise our tests against the specification's requirements and examples
   (`conformance`). Every MUST test that runs passes, and each skipped test is
   named with its reason. A test that fails only because it contradicts the
   specification, or assumes an input mode the profile does not declare, is
   recorded the same way, with the specification section and the upstream
   report.
4. Operational docs exist, with crash and replay coverage (`docs`,
   `combinations`).

"Supported" covers the recorded subset, never the whole specification. HTTP,
MCP and x402 were supported before 2.8.0 introduced these criteria, and keep
that status. Upstream does not label x402 v2 stable, and its record says so.

## Protocol pages

- [HTTP surface](protocols/http.md): routes, and the payment headers each rail
  uses on the invoke route
- [MCP](protocols/mcp.md): tools, payment over MCP, and exclusions
- [A2A](protocols/a2a.md): invocation and payment, the x402 extension, results,
  and exclusions
- [ACP](protocols/acp.md): headers, checkout operations, the payment boundary,
  idempotency, errors, discovery, and exclusions
- [x402](protocols/x402.md): the `exact` scheme on EVM, Solana and NEAR,
  several options, payment flows, and mainnet guardrails
- [MPP](protocols/mpp.md): the pinned drafts, the `charge` profile, payment
  flow, problem documents, and exclusions
- [AP2](protocols/ap2.md): mandate verification before a paid resource settles

## Adding an integration

See [contributing-adapters.md](contributing-adapters.md). Adapter and provider
implementations keep protocol-specific logic outside `src/core`; new protocol
or rail names require an approved frozen-contract change.
