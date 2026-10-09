# Example: multi-network-mainnet

> **Real funds.** A template for offering one resource on several mainnets.
> Payments have settled on Base and Solana. Polygon and Arbitrum One are
> supported but have not run with real funds.

One resource, four offers: USDC on Base, Polygon, Arbitrum One and Solana. The
challenge lists all four, and the buyer's proof selects one. Each offer has
its own `payTo` and RPC endpoint, and all of them settle through one
facilitator. Config load requires `allowMainnet: true` and each network's own
USDC, and startup refuses an Anvil development address as `payTo`.

## What you need

|                    |                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| Merchant addresses | `MERCHANT_WALLET` for the EVM networks, `SOLANA_MERCHANT_WALLET` with an existing USDC token account. |
| A facilitator      | `X402_FACILITATOR_URL` and `X402_FACILITATOR_TOKEN`, listing all four networks in `/supported`.       |
| Solana support     | `npm install @x402/svm@2.25.0 @solana/kit@5.5.1`                                                      |
| An admin token     | `ADMIN_TOKEN`, which protects the receipts and events routes.                                         |

Check that the facilitator's `/supported` lists every network; otherwise
health and readiness fail.
For a facilitator that takes no credential, replace the `auth` block with
`type: none` and add `allowUnauthenticatedFacilitator: true`, as in
[base-mainnet-payai](../base-mainnet-payai/README.md).

```bash
ALLOW_X402_MAINNET=true MERCHANT_WALLET=0x... SOLANA_MERCHANT_WALLET=... \
X402_FACILITATOR_URL=https://... X402_FACILITATOR_TOKEN=... ADMIN_TOKEN=... \
  npm run agent-commerce -- doctor --config examples/multi-network-mainnet/config.yaml
```

`doctor` names each network in its mainnet safety check, and compares every
live offer with this config.

## Proving a route

`npm run test:mainnet` settles one small payment per named target, with
`base`, `base-permit2`, `solana` and `near` allowlisted; see
[docs/smoke-tests.md](../../docs/smoke-tests.md).
Polygon and Arbitrum One have no mainnet smoke target yet.
