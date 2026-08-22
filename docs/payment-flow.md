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
`402` body — and, for x402 v2 clients, in the base64 `PAYMENT-REQUIRED`
response header — while the proof travels in the `PAYMENT-SIGNATURE` header
instead of the reserved `_payment` tool input. The settlement result comes back
in `PAYMENT-RESPONSE`.

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
| wrong amount (`value < amount`) | `PAYMENT_INVALID` | no |
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

- Anvil, `--chain-id 84532`, advertised as the CAIP-2 network `eip155:84532`.
  That id is shared with the public Base Sepolia testnet, so nothing infers
  "public network" from it — `health()` probes for `anvil_nodeInfo` instead.
- `MockUSDC`: 6 decimals, EIP-3009, EIP-712 domain `("MockUSDC", "2")`.
- Anvil's well-known accounts as deployer/facilitator, merchant and buyer —
  `LOCAL DEVELOPMENT ONLY - DO NOT FUND`.
- The E2E asserts the buyer's balance falls and the merchant's rises by exactly
  the price, and that the receipt carries a real transaction hash.

No public RPC, no public chain, no hosted facilitator, no real money. See
 for the exact SDK behaviour this
relies on.

## Public networks — configurable, not yet exercised

Base Sepolia and Base mainnet can now be configured, and so can a remote HTTP
facilitator; what has not happened is a settled payment on a public chain.
Every settlement this release has actually performed was against the local
deterministic chain, and that is the path the tests cover.

Three things shape what a public-network config is allowed to look like:

- **The deployment mode is derived, not declared.** `local`, `testnet` and
  `mainnet` come from the network *and* the facilitator together, because chain
  id 84532 belongs to both the local dev chain and public Base Sepolia. Nothing
  infers "public network" from the id alone.
- **Mainnet is refused unless every guardrail is satisfied** — explicit
  `allowMainnet`, a remote facilitator over HTTPS carrying a credential, a
  non-development `payTo`, and the canonical USDC for the chain. These are
  checked at config load, so `agent-commerce validate` catches them, and the
  gateway will not start without them. See
  [configuration.md](configuration.md).
- **In local mode `health()` still probes `anvil_nodeInfo`**, so a local
  facilitator pointed at a real node reports unhealthy and `/ready` returns
  503. In remote mode it asks the facilitator what it supports instead, and
  fails if our scheme and network are not on the list.

There is still no "live mode" toggle. There is configuration, and there are
checks that refuse the combinations that would lose money.
