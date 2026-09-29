# Example: base-mainnet-payai (REAL FUNDS)

This example settles x402 v2 `exact` payments on Base through PayAI's public
facilitator, with `auth.type: none`.
[PayAI's pricing guide](https://docs.payai.network/x402/facilitators/pricing)
says ordinary exact payments need no API key within a free credit allowance.
The allowance is per receiving wallet and never resets; beyond it, PayAI
requires credits and
[authentication](https://docs.payai.network/x402/facilitators/authentication).
The gateway still needs its x402 peers, but not `@coinbase/x402`.

Check the payment kinds PayAI advertises before spending real USDC:

```bash
node -e "fetch('https://facilitator.payai.network/supported').then(r=>r.json())
  .then(d=>console.log(d.kinds.filter(k=>k.network==='eip155:8453')))"
```

Confirm the output includes protocol v2 and the `exact` scheme.

## Two acknowledgments, not one

```yaml
allowMainnet: true                     # I meant to use real money
allowUnauthenticatedFacilitator: true  # I accept THIS counterparty
```

Neither implies the other, and config loading rejects this file if either is
missing. `doctor` reports unauthenticated mainnet settlement as a **WARN**.

## Limits and risks

An EIP-3009 authorization fixes the recipient, amount and chain, so the
facilitator cannot redirect that signed transfer. It can see each authorization
sent to it, including the payer address, amount and timing.

This config sends no credential, so once the `payTo` wallet's free allowance
is used up, paid calls fail closed.

For sustained use, choose a facilitator whose authentication the gateway
supports (`bearer` or `cdp`), or operate your own remote facilitator. See
[configuration](../../docs/configuration.md).

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

**Each successful x402 smoke run spends real USDC** (default 0.01). Setting
`ALLOW_MPP_MAINNET=true` also enables the separate, paid MPP smoke suite.

The smoke test checks the buyer and merchant balance changes and reads the
transaction receipt from Base to confirm settlement.
