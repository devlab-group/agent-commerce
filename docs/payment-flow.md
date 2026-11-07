# Payment flow

How the gateway verifies, settles and records a paid invocation.

## Roles

| Role        | Key material                        | Where it runs                                  |
| ----------- | ----------------------------------- | ---------------------------------------------- |
| Buyer agent | its own payment key                 | the agent's machine (`demo/agent` in the demo) |
| Gateway     | no buyer or merchant key required   | merchant infrastructure                        |
| Facilitator | a gas-paying signer key             | gateway process in local mode; remote service  |
| Merchant    | address configured; no key required | `payTo` for x402; `recipient` for MPP          |

The gateway coordinates the protocol without taking custody. Local mode keeps
the facilitator signer in the gateway process;
[security.md](security.md#mainnet) says where that mode is allowed.

## The x402 round trip

The diagram shows the default `authorization` flow: the backend answers before
the payment settles, so a backend failure settles nothing, and a refused
settlement withholds the backend's response. Under the `upfront` flow,
configured per rail or per resource, `settle` moves above the backend call; see
[x402](protocols/x402.md).

```text
 buyer                           gateway                         chain / backend
   │                                │                                   │
   │ 1. tools/call market_report    │                                   │
   ├───────────────────────────────►│                                   │
   │                                │ resolve resource, validate input  │
   │                                │ price 0.01 USDC → paid            │
   │                                │ createRequirement                 │
   │◄───────────────────────────────┤ PaymentRequiredEnvelope           │
   │ 2. isError + envelope          │ (x402 PaymentRequirements)        │
   │    payment.accepts[0]          │                                   │
   │                                │                                   │
   │ 3. sign EIP-3009 authorization │                                   │
   │    (to = merchant payTo)       │                                   │
   │                                │                                   │
   │ 4. tools/call + _payment       │                                   │
   ├───────────────────────────────►│                                   │
   │                                │ verify: signature, recipient,     │
   │                                │         amount, window,           │
   │                                │         network, asset            │
   │                                ├──────────────────────────────────►│ chain: balance / allowance
   │                                │ replayKey = H(chainId, asset,     │
   │                                │               payer, nonce)       │
   │                                │ reservePaymentAttempt(replayKey)  │
   │                                │   duplicate ⇒ PAYMENT_REPLAYED    │
   │                                │ call merchant backend             │
   │                                ├──────────────────────────────────►│ backend: GET /api/report
   │                                │◄──────────────────────────────────┤ backend: 200 + body
   │                                │ settle                            │
   │                                ├──────────────────────────────────►│ chain: transferWithAuthorization
   │                                │◄──────────────────────────────────┤ chain: tx receipt
   │                                │ saveReceipt(txHash)               │
   │                                │                                   │
   │◄───────────────────────────────┤                                   │
   │ 5. result + receipt            │                                   │
```

Over HTTP, x402 sends the challenge in the `402` body and base64
`PAYMENT-REQUIRED` header, accepts the proof in `PAYMENT-SIGNATURE`, and returns
the settlement result in `PAYMENT-RESPONSE`. MCP and A2A carry the same proof in
the reserved `_payment` input field. MCP also accepts the selected rail's
`_meta` carrier; see [Payment over MCP](protocols/mcp.md#payment-over-mcp). A2A
also accepts the x402 extension's task metadata; see
[x402 extension](protocols/a2a.md#x402-extension).
With [ERC-8409 quotes](protocols/x402.md#erc-8409-signed-quotes) enabled, the
challenge also carries a signed quote for each EVM offer.

### MPP

MPP uses the same verification and replay checks, with these differences:

- The challenge is HMAC-bound to its terms and resource, and the buyer's
  EIP-3009 nonce must equal the challenge hash, so an authorization answers
  exactly one challenge.
- Verification runs local checks, then the x402 settlement provider's
  read-only facilitator check. Both happen before the pipeline reserves the
  replay key, and neither broadcasts the payment.
- Settlement uses an x402 facilitator. MPP derives the same replay key as x402,
  so one receipt store cannot reserve the authorization through both rails.
- MPP uses the same flow values as x402 but defaults to `upfront`, as its
  `charge` intent requires. Under `authorization`, the backend must respond
  before the challenge expires; see [MPP](protocols/mpp.md).

Over HTTP, MPP uses `WWW-Authenticate`, `Authorization: Payment ...` and
`Payment-Receipt`. See the complete [HTTP header table](protocols/http.md).

## Why the money cannot be redirected

The buyer signs an EIP-3009 `TransferWithAuthorization` whose `to` field is the
merchant destination. The signature covers `from`, `to`, `value`,
`validAfter`, `validBefore` and `nonce`, bound to the token contract and chain
id through the EIP-712 domain. A broadcaster can execute that transfer or
nothing; it cannot change the destination or amount.

With [Permit2](configuration.md#permit2), the buyer signs
`PermitWitnessTransferFrom`, binding the token, amount, nonce, deadline,
x402 exact proxy as spender, and merchant destination as witness. The proxy
transfers only the signed amount to that destination.

So the gateway can confirm a payment without holding the funds or being able
to redirect them.

## Fail-closed matrix

| Condition                                                    | Result                                   | Delivered?                            |
| ------------------------------------------------------------ | ---------------------------------------- | ------------------------------------- |
| no proof supplied                                            | `PaymentRequiredOutcome`, 402 + envelope | no                                    |
| malformed proof                                              | `PAYMENT_INVALID`                        | no                                    |
| bad signature                                                | `PAYMENT_INVALID`                        | no                                    |
| amount mismatch                                              | `PAYMENT_INVALID`                        | no                                    |
| wrong recipient (`to != payTo`)                              | `PAYMENT_INVALID`                        | no                                    |
| wrong network                                                | `PAYMENT_INVALID`                        | no                                    |
| wrong asset                                                  | `PAYMENT_INVALID`                        | no                                    |
| authorization expired / not yet valid                        | `PAYMENT_INVALID`                        | no                                    |
| insufficient balance                                         | `PAYMENT_INVALID`                        | no                                    |
| authorization spent on chain, no unfinished attempt          | `PAYMENT_INVALID`                        | no                                    |
| authorization spent on chain while its attempt is unfinished | `PAYMENT_REPLAYED` (409, no challenge)   | no                                    |
| copy reaches gateway reservation before the original settles | `PAYMENT_REPLAYED`                       | no                                    |
| provider/RPC unavailable during verification                 | `PAYMENT_PROVIDER_UNAVAILABLE`           | no                                    |
| settlement transaction fails                                 | `PAYMENT_SETTLEMENT_FAILED`              | no                                    |
| backend fails before settlement (`authorization` flow)       | `BACKEND_ERROR` / `BACKEND_TIMEOUT`      | no; nothing settled; x402 can retry   |
| backend fails after settlement (`upfront` flow)              | `BACKEND_ERROR` / `BACKEND_TIMEOUT`      | no; payment recorded, delivery failed |

After settlement, a backend failure needs reconciliation rather than a
rollback. The gateway records a `settled` payment attempt and a
`backend.failed` event with the same `requestId`.

## Replay: two independent defenses

1. **On-chain.** EIP-3009 marks `authorizationState[from][nonce]` used; a second
   `transferWithAuthorization` with the same nonce reverts. Permit2 marks the
   owner's nonce used in its own bitmap, across every token. A Solana cluster
   refuses a transaction it has already processed, and one whose blockhash
   has expired. NEAR refuses a delegate whose nonce is at or below its access
   key's nonce. This prevents a double *spend*.
2. **In the gateway.** Concurrent submissions could unlock a second delivery
   before the first settles. The pipeline reserves `replayKey`, derived from
   `(chainId, asset, payer, nonce)` for EIP-3009, `(chainId, Permit2, owner, nonce)`
   for Permit2, the network and SHA-256 of the transaction message for Solana,
   or `(network, sender, public key, nonce)` for NEAR, under a `UNIQUE`
   constraint **before** calling `settle`. A duplicate returns
   `PAYMENT_REPLAYED`: 409 while the first attempt is unfinished or its status is
   unavailable; 402 with a fresh challenge when its stored status is treated as finished.
   If the transfer has already landed, a replay can fail verification before
   reaching the reservation. When the rejected proof carries a replay key,
   the pipeline looks up the attempt holding it. An unfinished attempt still
   returns 409 without a challenge. No match or a finished attempt returns
   402 `PAYMENT_INVALID` with a fresh challenge; so does a custom store without
   `findPaymentAttemptByReplayKey`. A lookup failure returns `STORAGE_ERROR`
   without a challenge.
   A rejected x402 attempt settled nothing: the backend failed, settlement was
   refused or the facilitator never submitted it. The same authorization can
   reserve it again. MPP keeps the 402: a credential is single-use per challenge.

Because the key comes from the authorization rather than the request, replaying
it against another request still collides.

An AP2 mandate adds a third reservation: an authorization hold with its own
key. The built-in SQLite store keeps it beside payment attempts. It is claimed
before the payment replay key; failures release it only when no money could
have moved. See [AP2](protocols/ap2.md#replay-states).

## Retry after a lost response

Experimental and disabled by default. A resource with
[`idempotency.redelivery`](configuration.md#resources) stores delivered
response under a buyer-chosen key so a lost response can be retrieved without
another charge. The key is the x402
[`payment-identifier`](protocols/x402.md#payment-identifier) `id`, the MPP
[`Idempotency-Key`](protocols/mpp.md#idempotency-key) header, or
`CanonicalRequest.retryKey` from a direct caller. Requests without a key follow
the flow above.

A key identifies one purchase of one resource with one input. Its row is
scoped by `merchant.publicBaseUrl`, the resource and the key's hash. The
fingerprint covers only the input digest. A fresh proof from the same payer
can retrieve the response even if the network, asset or amount has changed,
provided it verifies against a current offer.

For a request with a proof and a key:

1. Before verification, the gateway reads the row without writing. Only the
   exact proof that owns it can retrieve the stored response or get 409
   `payment_identifier_in_flight` or `payment_identifier_unresolved` for an
   unfinished claim. This path performs no verification, settlement or backend
   call, even if the proof or challenge has expired.
2. Other proofs are verified first. Invalid or forged proofs get the normal
   refusal, without revealing whether the key exists or what input it holds.
3. A verified proof claims the key before authorization holds and replay
   reservations. A new key proceeds as an ordinary purchase; an unfinished
   claim refuses as in step 1. A completed claim returns the response for the
   same input and verified payer, without settling the fresh proof. Different
   input, a different or unknown payer, or a different mandate gets 409
   `payment_identifier_conflict` after one `verify()` that moves no funds.

If the resource requires authorization, both routes require the purchase's
original authorization submission, byte for byte. The mandate is not verified
again because the purchase consumed it. Without it, an exact resend falls
through to verification; a verified fresh proof gets 409
`payment_identifier_conflict`. Purchases made before the resource required
authorization cannot be redelivered.

The purchase outcome determines the key's state:

| Purchase outcome                                                                                             | Key state                                                                                                       |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Delivered                                                                                                    | `completed`: retries get the stored response                                                                    |
| Uncharged failure: AP2 or replay refusal, refused settlement, or backend failure in the `authorization` flow | Released: the key can buy again                                                                                 |
| Uncertain settlement, or backend failure after `upfront` settlement                                          | `unresolved`: retries get 409 without a stored response                                                         |
| Delivered, but the response or receipt could not be stored                                                   | `unresolved`, or in flight until the next start if that write also fails; the buyer still received the response |
| Crash or restart while in flight                                                                             | `unresolved` at the next start, even if the crash preceded settlement                                           |

Retry-key 409s carry no challenge, because a challenge could prompt a second
payment. Only the in-flight 409 is retryable (`retryable: true`,
`retryAfterSeconds: 1`). Wait, then resend with the same key; a new key can
start another purchase. `reconcile` and `resolve` record the payment attempt's
outcome but do not change the key.

Completed and unresolved keys expire `retentionHours` (1 to 8760, default 24)
after the claiming request first reads the key, which is before verification.
After expiry, retries follow the normal purchase flow. Removing `redelivery`
from a resource, renaming it or changing `merchant.publicBaseUrl` also hides
its rows. ACP's unresolved records never expire.

A redelivery writes no receipt, payment attempt or journal row. Its outcome
carries its own `transactionId`, as do its events. When available, the purchase's
ID is `receipt.transactionId` and is copied to the `resource.delivered` event's
`data.originalTransactionId`.

An exact resend is an exception to the fail-closed rule: it retrieves an
already-paid response without verification, settlement or a new backend call.
[Security](security.md#buyer-protection) covers what the key protects and how to
treat it.

## Transactions

After `execute()` resolves a resource, core allocates a `transactionId` for the
call and includes it in events, returned outcomes and receipts. With SQLite,
a paid call reaching replay reservation also gets a payment attempt and journal
row with that ID. Both are inserted in one transaction; a failed journal insert
ends the call with `STORAGE_ERROR` before settlement. Free calls, 402 challenges
and refused replays carry the ID without a journal row.

The row links the payment attempt, any authorization hold, the backend call
and receipt. Its timestamps and results reflect the steps saved so far.
Core stores an input digest when the input can be canonicalized, rather than
the body. Journal fields must not contain payment proofs, signatures,
mandates or secrets. Payment status comes from the attempt; the transaction
state is derived from the recorded facts when the row is read:

| State                 | Meaning                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `payment-pending`     | Reserved, with no settlement verdict recorded                                                                     |
| `payment-failed`      | The payment attempt is recorded as rejected                                                                       |
| `payment-uncertain`   | `settlement-uncertain` or legacy `failed`: funds may have moved                                                   |
| `delivery-started`    | Before the backend deadline, with no completion recorded; the call or a settled 2xx flow may still be in progress |
| `delivery-unknown`    | Settled; the backend ended without a response, or its deadline passed without confirmed delivery                  |
| `settled-undelivered` | Settled, with no backend call recorded or a recorded non-2xx response                                             |
| `delivered`           | Settled, with a recorded 2xx backend result and pipeline completion                                               |

Once the backend deadline passes, an unfinished `delivery-started` transaction
is read as `delivery-unknown` if settled or `payment-pending` otherwise. No
write is needed for this change. Consumers must handle new state names added
by later releases.

After reservation, failed store writes preserve delivery or the original
commerce error and are logged at `error`. Delivered outcomes and terminal
events include the `persistenceFailures` known when they are created. The
final journal write stores the list if it succeeds; a failed `completed`
step adds no detail to earlier snapshots. Thrown errors do not carry the list.
A failed receipt write adds `receiptCommitted: false` to the MCP and A2A
delivery summary.

Operators list rows with `GET /api/transactions?unresolved=true` and read one
with its attempt, receipt and events at `GET /api/transactions/:id`
([routes](contracts.md#gateway-http-surface)).

### Reconciliation

`agent-commerce reconcile` asks payment providers for chain evidence to resolve
uncertain attempts. The built-in providers use read-only RPC calls without
contacting facilitators. The command records local resolutions and hold
updates without broadcasting, refunding or retrying delivery.

- **settled** requires a final transfer matching the authorization.
- **not settled** requires final chain state showing the authorization unused
  after its last valid moment. Missing logs, receipts or history entries alone
  do not prove nonpayment. Solana reconciliation does not return this result.
- Inconclusive evidence stays **unknown**, with a reason, for a later run or
  operator investigation followed by `agent-commerce resolve`.

Resolutions record method, actor, reason, time and any available evidence.
The write requires the attempt's expected status and no existing resolution,
so competing resolvers cannot overwrite each other. Later runs skip resolved
payments but, with AP2 enabled, can retry pending mandate consume or release
updates. The [README](../README.md#agent-commerce-reconcile) covers the flags
and the evidence each chain family needs.

## Amounts

Canonical amounts are decimal strings in display units, such as `"0.01"`, never
floats. Conversion to base units (6 decimals for USDC) happens inside the
payment provider. An amount with more precision than the
asset supports is a configuration error, not a rounding opportunity.

An x402 payment in the network's default USDC records `currency: USDC`,
keeping a resource's `USD` price as `metadata.quote` on settlement. Other
configured tokens use the resource's currency label.

## Local deterministic settlement

The demo and CI settle for real, on a chain they own:

- Anvil on its default chain id 31337, advertised as the CAIP-2 network
  `eip155:31337`. `health()` also probes for `anvil_nodeInfo`, because an RPC
  can report any chain id.
- `MockUSDC`: 6 decimals, EIP-3009, EIP-712 domain `("MockUSDC", "2")`.
- Anvil's well-known accounts as deployer/facilitator, merchant and buyer,
  labeled `LOCAL DEVELOPMENT ONLY - DO NOT FUND`.
- The E2E asserts the buyer's balance falls and the merchant's rises by exactly
  the price, and that the receipt carries a real transaction hash.
- A second E2E settles on Anvil chains 31338 and 31339 through a loopback
  SDK `x402Facilitator`, exercising the remote path used for public networks.

No public RPC, no public chain, no hosted facilitator, no real money.

## Public networks

Both x402 and MPP have settled on Base Sepolia (`eip155:84532`) and Base
mainnet (`eip155:8453`) through the same pipeline and remote facilitator model.
Public-network configuration follows these rules:

- **The deployment mode comes from the network.** `eip155:31337` is the local
  chain; every other network is the testnet or mainnet it names, and the
  in-process facilitator is refused on all of them.
- **Mainnet is refused unless every guardrail is satisfied** - an explicit
  `allowMainnet`, a remote facilitator over HTTPS, a second explicit
  acknowledgment if no facilitator credential is configured, a non-development
  settlement destination, and canonical USDC with its EIP-712 domain on
  built-in mainnets. Config validation checks these before startup;
  `agent-commerce validate` reports missing guards. See [configuration.md](configuration.md).
- **`assetName` is part of that.** Base mainnet's USDC reports `"USD Coin"`,
  Base Sepolia's reports `"USDC"`, and the buyer signs that string into their
  EIP-712 domain. Config validation rejects a mismatch before the buyer signs.
- **`health()` asks the right question per mode.** In local mode it probes
  `anvil_nodeInfo`, so a local facilitator pointed at a real node reports
  unhealthy and `/ready` refuses to serve. In remote mode it asks the
  facilitator what it supports and fails if our scheme and network are not on
  its list: a facilitator that is up but cannot settle this pair would
  otherwise fail every payment after the buyer signed.

`allowMainnet` acknowledges real-money operation; it does not enable a separate
runtime path.

Running against a public network is [configuration.md](configuration.md); a
worked config for each is in `examples/base-sepolia/` and
`examples/base-mainnet/`.
