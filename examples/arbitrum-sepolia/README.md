# Example: arbitrum-sepolia

The [base-sepolia](../base-sepolia/README.md) example on another EVM testnet,
`eip155:421614`. The config leaves out the asset fields, so payments settle in
Arbitrum Sepolia's USDC with the EIP-712 domain and decimals from the
built-in profile.

The facilitator must list `eip155:421614` in its `/supported` response. On
2026-10-07 PayAI's facilitator listed it, and x402.org's listed only Base
Sepolia among EVM networks. Check before use:

```bash
node -e "fetch('https://facilitator.payai.network/supported').then(r=>r.json())
  .then(d=>console.log(d.kinds.filter(k=>k.network==='eip155:421614')))"
```

## What you need

|                    |                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------- |
| A merchant address | any address you control. `MERCHANT_WALLET`. Address only, no key.                       |
| A funded buyer     | Arbitrum Sepolia USDC from https://faucet.circle.com. No ETH: the facilitator pays gas. |

```bash
MERCHANT_WALLET=0xYourMerchantAddress \
  npm run agent-commerce -- validate --config examples/arbitrum-sepolia/config.yaml
```

Run it as in the base-sepolia example, with
`AGENT_COMMERCE_CONFIG=examples/arbitrum-sepolia/config.yaml`.

## Proving it settles

```bash
X402_SMOKE_TARGETS=arbitrum-sepolia \
X402_TESTNET_BUYER_PRIVATE_KEY=0x... \
X402_TESTNET_MERCHANT_ADDRESS=0xYourMerchantAddress \
  npm run test:testnet
```

The run verifies the receipt's USDC `Transfer`; see
[docs/smoke-tests.md](../../docs/smoke-tests.md). It has not run on Arbitrum
Sepolia.
