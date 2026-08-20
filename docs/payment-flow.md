# Payment flow

How a paid resource actually gets paid for, end to end, in v0.1.0-alpha.

## Roles

| Role | Holds a key? | Where it runs |
|---|---|---|
| Buyer agent | yes — its own | the agent's machine (`demo/agent` in the demo) |
| Gateway | **no** | merchant infrastructure |
| Facilitator | a gas-paying signer | local dev chain in the demo; external in production |
| Merchant | destination address only | configuration (`payTo`) |

The gateway is in the middle of the *protocol* and outside the *custody*.

## The round trip

```text
 buyer gateway chain / backend
   │ │ │
   │ 1. tools/call market_report │ │
   ├────────────────────────────►│ │
   │ │ resolve resource, validate input │
   │ │ price: 0.01 USDC → paid │
   │ │ createRequirement │
   │ 2. isError + envelope │ │
   │◄────────────────────────────┤ PaymentRequiredEnvelope │
   │ payment.accepts[0] │ (x402 PaymentRequirements) │
   │ │ │
   │ 3. sign EIP-3009 │ │
   │ authorisation │ │
   │ (to = merchant payTo) │ │
   │ │ │
   │ 4. tools/call + _payment │ │
   ├────────────────────────────►│ │
   │ │ verify ── signature, recipient,│
   │ │ amount, window, │
   │ │ balance, network, │
   │ │ asset ───────────────┤ read
   │ │ replayKey = H(chainId, asset, │
   │ │ payer, nonce) │
   │ │ reservePaymentAttempt(replayKey) │
   │ │ duplicate ⇒ PAYMENT_REPLAYED │
   │ │ settle ─────────────────────────┤ tx
   │ │ transferWithAuthorization│
   │ │◄──────────────────────────────────┤ receipt
   │ │ call merchant backend ────────────┤
   │ │◄──────────────────────────────────┤ 200
   │ │ saveReceipt(txHash) │
   │ 5. result + receipt │ │
   │◄────────────────────────────┤ │
```

Steps 1–2 and 4–5 are the same over plain HTTP; the challenge arrives as a
`402` body and the proof travels in the `X-PAYMENT` header instead of the
reserved `_payment` tool input.

## Why the money cannot be redirected

The buyer signs an EIP-3009 `TransferWithAuthorization` whose `to` field **is**
the merchant destination. The signature covers `from`, `to`, `value`,
`validAfter`, `validBefore` and `nonce`, bound to the token contract and chain
id through the EIP-712 domain. Whoever broadcasts it — gateway, facilitator,
anyone — can only execute exactly that transfer or nothing.

That is what makes a non-custodial gateway possible: it can prove a payment
happened without ever being able to take it.

## Fail-closed matrix

| Condition | Result | Delivered? |
|---|---|---|
| no proof supplied | `PaymentRequiredOutcome`, 402 + envelope | no |
| malformed proof | `PAYMENT_INVALID` | no |
| bad signature | `PAYMENT_INVALID` | no |
| wrong amount (`value < maxAmountRequired`) | `PAYMENT_INVALID` | no |
| wrong recipient (`to != payTo`) | `PAYMENT_INVALID` | no |
| wrong network | `PAYMENT_INVALID` | no |
| wrong asset | `PAYMENT_INVALID` | no |
| authorisation expired / not yet valid | `PAYMENT_INVALID` | no |
| insufficient balance | `PAYMENT_INVALID` | no |
| authorisation already seen | `PAYMENT_REPLAYED` | no |
| provider/RPC unreachable | `PAYMENT_PROVIDER_UNAVAILABLE` (retryable) | no |
| settlement transaction fails | `PAYMENT_SETTLEMENT_FAILED` | no |
| backend fails **after** settlement | `BACKEND_ERROR` / `BACKEND_TIMEOUT` | no — payment recorded, delivery failed |

The last row is the honest one: settlement is final, so a backend failure after
payment is a reconciliation problem, not a rollback. It is recorded as a
`payment_attempt` with status `settled` and a `backend.failed` event sharing the
same `requestId`, and it is an explicitly tested case.

## Replay: two independent defences

1. **On-chain.** EIP-3009 marks `authorizationState[from][nonce]` used; a second
   `transferWithAuthorization` with the same nonce reverts. This prevents a
   double *spend*.
2. **In the gateway.** A replayed authorisation could still be presented twice
   in quick succession and unlock a second delivery before the first settles.
   So the pipeline reserves `replayKey` — derived only from
   `(chainId, asset, payer, nonce)` — under a `UNIQUE` constraint **before**
   calling `settle`. The second request is `PAYMENT_REPLAYED`.

Deriving the key from the authorisation rather than the request is what makes
it work: the same authorisation replayed against a *different* request still
collides.

## Amounts

Canonical amounts are decimal strings in display units — `"0.01"` — never
floats. Conversion to base units (6 decimals for USDC) happens inside the
payment provider, deterministically. An amount with more precision than the
asset supports is a configuration error, not a rounding opportunity.

## Local deterministic settlement

The demo and CI settle for real, on a chain they own:

- Anvil, `--chain-id 84532`, so x402's `base-sepolia` network id matches.
- `MockUSDC`: 6 decimals, EIP-3009, EIP-712 domain `("MockUSDC", "2")`.
- Anvil's well-known accounts as deployer/facilitator, merchant and buyer —
  `LOCAL DEVELOPMENT ONLY - DO NOT FUND`.
- The E2E asserts the buyer's balance falls and the merchant's rises by exactly
  the price, and that the receipt carries a real transaction hash.

No public RPC, no public chain, no hosted facilitator, no real money. See
 for the exact SDK behaviour this
relies on.

## Live settlement (planned, not in v0.1.0-alpha)

This release settles **only** against the local deterministic chain. Two
independent things in the tree prevent a real network, deliberately:

- `payments.x402.facilitator.mode: "remote"` is rejected at config load
  (`src/config/schema.ts`), so a hosted facilitator cannot be configured.
- In local mode the provider's `health` probes an Anvil-only RPC method
  (`anvil_nodeInfo`), so against a real node it reports unhealthy and the
  gateway's `/ready` returns 503.

There is no "live mode" to enable, and no wording here should suggest one.
v0.1 settles against the deterministic local chain only — the three checks
above are what stop a mainnet deployment starting, and they are checks, not
a toggle.
