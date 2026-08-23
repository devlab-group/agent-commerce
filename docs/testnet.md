# Base Sepolia

Running the gateway against a public testnet, and proving that a payment
actually settled there.

> **Status.** Demonstrated. A real payment settled on Base Sepolia on
> 2026-08-22 —
> [`0xf3288399…`](https://sepolia.basescan.org/tx/0xf3288399e31eab683f9bced802fad2dcf44072f93e1aa51223a0f8398e7668e8).
> Details at the bottom: [Has it actually settled?](#has-it-actually-settled).

## What changes, and what doesn't

Nothing in the application. A public testnet is a different `network` and a
different facilitator:

```yaml
payments:
  x402:
    network: eip155:84532
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" # Circle USDC
    assetName: USDC
    assetVersion: "2"
    assetDecimals: 6
    payTo: ${MERCHANT_WALLET}
    facilitator:
      mode: remote
      url: https://x402.org/facilitator
      auth:
        type: none
```

A complete file is in [`examples/base-sepolia/config.yaml`](../examples/base-sepolia/config.yaml).

Two things go away:

- **The gateway holds no signing key.** `facilitator.mode: local` needs a
  `signerPrivateKey` to broadcast; a remote facilitator does that itself, and
  pays the gas.
- **MockUSDC goes away.** `asset` is the real Circle deployment.

## The chain id trap

Base Sepolia's chain id is **84532** — the same one this project's local Anvil
chain uses, deliberately, so the unmodified x402 SDK can talk to it. Nothing
may read "public network" out of the network id alone.

What distinguishes them is the facilitator. `local | testnet | mainnet` is
derived from the network *and* the facilitator together, and is reported by
`doctor`, by the provider's `health()`, and at `/.well-known/agent-commerce`
as `payments.x402.mode`. A local deployment says so:

```console
PASS  Payments   x402 v2 (scheme=exact) enabled — LOCAL dev chain (eip155:84532,
                 chain id shared with Base Sepolia), destination=0x7099…79C8,
                 facilitator=local
```

## What you need

| | |
|---|---|
| Merchant address | any address you control (`MERCHANT_WALLET`). **Address only.** The gateway never wants a merchant key, on any network. |
| Buyer wallet | a dedicated test wallet holding Base Sepolia USDC. Get it from https://faucet.circle.com. |
| Buyer ETH | **none.** The buyer signs an EIP-3009 authorisation offline; the facilitator broadcasts it and pays the gas. |
| RPC endpoint | only used for health checks — the facilitator does the chain work. The public default works; a dedicated endpoint is more reliable. |

The public facilitator at `https://x402.org/facilitator` advertises
`x402Version: 2, scheme: exact, network: eip155:84532` and takes no
credential. Check for yourself before trusting this page:

```bash
node -e "fetch('https://x402.org/facilitator/supported').then(r=>r.json()).then(d=>
  console.log(d.kinds.filter(k=>k.network==='eip155:84532')))"
```

`health()` asks the configured facilitator the same question at startup and
fails if our scheme and network are not on its list — a facilitator that is up
but cannot settle this pair would otherwise fail every payment, after the
buyer has already signed.

## Proving it settles

```bash
set -a; . ./.env.testnet; set +a   # or export the variables yourself
npm run test:testnet
```

`.env.testnet` is git-ignored and holds the wallets. Nothing loads it
automatically — sourcing it is deliberate, so a testnet key never leaks into a
shell that did not ask for one.

| Variable | Default |
|---|---|
| `X402_TESTNET_BUYER_PRIVATE_KEY` | required |
| `X402_TESTNET_MERCHANT_ADDRESS` | required |
| `X402_TESTNET_RPC_URL` | `https://base-sepolia-rpc.publicnode.com` |
| `X402_TESTNET_FACILITATOR_URL` | `https://x402.org/facilitator` |
| `X402_TESTNET_AMOUNT` | `0.01` |

The suite drives the real gateway through the whole chain — unpaid request,
402 v2 challenge, buyer signature, remote facilitator, settlement, delivery —
and then reads the **buyer and merchant balances and the transaction receipt
back off the network**. The gateway's own report of success is not the proof,
and a run that only saw an HTTP 200 fails.

It also re-checks fail-closed on the public network: an authorisation signed
for a different recipient is refused, and both balances are asserted
unchanged.

It spends `X402_TESTNET_AMOUNT` USDC on every run.

### Why it is not in `npm test`

`vitest.config.ts` and `vitest.e2e.config.ts` must never touch a public RPC,
a public chain or a hosted facilitator — that is what makes CI reproducible
and what keeps a fork's pull request from spending anything. This suite has
its own config (`vitest.testnet.config.ts`), its own script
(`npm run test:testnet`), and skips itself with an explanation when its
variables are absent.

In CI it is a manual workflow — `.github/workflows/testnet-smoke.yml`,
`workflow_dispatch` only, reading a dedicated buyer key from the `testnet`
environment's secrets. It is `concurrency: testnet-smoke` with
`cancel-in-progress: false`, because two concurrent runs share one buyer
wallet and two in-flight authorisations against one nonce space is the race
the gateway's replay reservation exists to catch — not something to trigger on
purpose. The workflow fails, rather than passing, when the secrets are missing
and the suite skips.

## Keys

The buyer key is read from the environment, never written to a config file,
never logged, and never included in an assertion message. Use a wallet created
for this and nothing else. A mainnet key must never appear here.

The merchant side never needs a key at all — only an address to settle to.

## Has it actually settled?

**Yes.** 2026-08-22, `npm run test:testnet` against public Base Sepolia and the
public facilitator at `https://x402.org/facilitator`:

| | |
|---|---|
| Transaction | [`0xf3288399e31eab683f9bced802fad2dcf44072f93e1aa51223a0f8398e7668e8`](https://sepolia.basescan.org/tx/0xf3288399e31eab683f9bced802fad2dcf44072f93e1aa51223a0f8398e7668e8) |
| Status | `0x1` (success), block 45823961, 85 728 gas |
| Amount | 0.01 USDC (`10000` base units) |
| Asset | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` — Circle USDC |
| Buyer | signed offline, holds no ETH, paid no gas |
| Gas paid by | `0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf` — the facilitator's own signer |
| Gateway | held no key, signed nothing, broadcast nothing |

Balances moved by exactly the price, read back from the chain rather than
taken from the gateway's own report. The receipt carries the transaction hash
and a delivery timestamp; the same run also confirmed fail-closed on the
public network, refusing an authorisation signed for a different recipient
with both balances unchanged.

### One thing the first run got wrong

It failed — `expected 0n to be 10000n` — on a payment that had plainly
settled. Read-your-writes does not hold across independent RPC nodes: the
facilitator confirmed against its node and returned, and the node this suite
reads from was still a block behind.

The suite now polls for the delta with a bounded timeout. The expected amount
is still exact and a settlement that never lands still fails — the polling
absorbs node lag, it does not soften the assertion. Worth knowing before
writing any other test against a public chain.
