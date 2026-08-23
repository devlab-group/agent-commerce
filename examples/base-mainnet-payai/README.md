# Example: base-mainnet-payai — REAL FUNDS

The cheapest way to prove the mainnet path works end to end. PayAI's public
facilitator serves x402 v2 `exact` on `eip155:8453` and takes **no
credential** — no account to open, no SDK to install, no `@coinbase/x402`.

Verified 2026-08-23:

```bash
node -e "fetch('https://facilitator.payai.network/supported').then(r=>r.json())
  .then(d=>console.log(d.kinds.filter(k=>k.network==='eip155:8453')))"
# [ { x402Version: 2, scheme: 'exact', network: 'eip155:8453' } ]
```

`/verify` and `/settle` answer `400 invalid_payment_requirements` on an empty
body rather than `401`, so no credential is required to call them.

## Two acknowledgements, not one

```yaml
allowMainnet: true                     # I meant to use real money
allowUnauthenticatedFacilitator: true  # I accept THIS counterparty
```

Neither implies the other, and dropping either one fails config loading:

```console
FAIL  CONFIG_INVALID: payments.x402: facilitator https://facilitator.payai.network
      takes no credential, and this is a mainnet deployment. It will see every
      payment authorisation you handle, with no account, terms or support behind
      it. Set payments.x402.allowUnauthenticatedFacilitator: true to accept that,
      or configure facilitator.auth.
```

`doctor` reports it as a **WARN**, not a pass, for as long as it stays this way.

## What you are and are not exposed to

**Not at risk: your money.** An EIP-3009 authorisation names its recipient, its
amount and its chain. A facilitator can broadcast exactly that transfer or
nothing — it cannot redirect funds to itself, and it cannot charge a different
amount.

**At risk:**

- **Availability.** No SLA, no account, nobody to call. If it rate-limits or
  disappears, every paid call fails closed — correct, and earning nothing.
- **Your payment graph.** It necessarily sees every authorisation: payer
  addresses, amounts, timing.
- **Continuity.** Nothing obliges it to stay free, or to stay up.

Fine for a proving run. Think harder before production. The alternatives are a
facilitator with a static token (`auth.type: bearer`, installs nothing), CDP
(`auth.type: cdp`, needs `@coinbase/x402`), or running your own — `mode:
remote` does not care who operates the endpoint. See
[docs/configuration.md](../../docs/configuration.md).

## Run it

```bash
ALLOW_X402_MAINNET=true MERCHANT_WALLET=0xYourWallet \
  npm run agent-commerce -- validate --config examples/base-mainnet-payai/config.yaml
```

To actually settle:

```bash
export ALLOW_X402_MAINNET=true
export X402_MAINNET_BUYER_PRIVATE_KEY=0x...   # funded with USDC on Base
export X402_MAINNET_MERCHANT_ADDRESS=0x...
export X402_FACILITATOR_URL=https://facilitator.payai.network
npm run test:mainnet
```

No credential variables needed. **Every run spends real USDC** (default 0.01).

This is the configuration Base mainnet settlement was first proven with: a real
0.01 USDC payment settled through PayAI, buyer down and merchant up by exactly
the price, verified by reading the balances and the transaction receipt back
off the chain.
