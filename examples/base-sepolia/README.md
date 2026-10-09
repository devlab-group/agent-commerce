# Example: base-sepolia

The same gateway as the local examples, settling **real USDC on a public
testnet** instead of on Anvil. It runs the same payment pipeline with a
different `network` and a remote facilitator.

Two things disappear compared to a local setup:

- **No `signerPrivateKey`.** With `facilitator.mode: remote` the gateway holds
  no signing key at all. The facilitator broadcasts the transfer and pays the
  gas.
- **No MockUSDC.** `asset` is Circle's real USDC on Base Sepolia,
  `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, EIP-712 domain `("USDC","2")`,
  6 decimals.

The buyer's key stays with the buyer. It never appears in any config file, and
the gateway never sees it.

## What you need

|                                  |                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| A merchant address               | any address you control. `MERCHANT_WALLET`. Address only, no key, ever.                                             |
| A buyer wallet with testnet USDC | https://faucet.circle.com. The buyer needs **no ETH**: EIP-3009 is signed offline and the facilitator pays the gas. |
| A Base Sepolia RPC               | only for health checks. The public default works; a dedicated endpoint is more reliable.                            |

Unlike the local examples, this one does **not** validate with no environment
set: `MERCHANT_WALLET` has no default, because the only default available
would be an Anvil development address, and the gateway refuses one of those on
any non-local deployment. That refusal is the feature.

```bash
MERCHANT_WALLET=0xYourMerchantAddress \
  npm run agent-commerce -- validate --config examples/base-sepolia/config.yaml
```

## Run it

```bash
# Terminal 1: your backend, or this repo's demo merchant API (foreground)
npm run dev:merchant

# Terminal 2: the gateway, on Base Sepolia
AGENT_COMMERCE_CONFIG=examples/base-sepolia/config.yaml \
  MERCHANT_WALLET=0xYourMerchantAddress \
  npm run dev:gateway

# Terminal 3: check the deployment
MERCHANT_WALLET=0xYourMerchantAddress \
  npm run agent-commerce -- doctor --config examples/base-sepolia/config.yaml
```

`doctor` reports the deployment as `TESTNET on Base Sepolia (eip155:84532)`.

## Proving it settles

```bash
X402_TESTNET_BUYER_PRIVATE_KEY=0x... \
X402_TESTNET_MERCHANT_ADDRESS=0xYourMerchantAddress \
  npm run test:testnet
```

The suite requests a challenge, signs it and settles through the facilitator,
then verifies the **USDC `Transfer` in the on-chain receipt**. Each x402 run
spends `X402_SMOKE_AMOUNT` (default `0.01`) USDC and skips with an explanation
if the required variables are absent. These variables also enable the separate
MPP Base Sepolia suite, whose amount is set by `X402_TESTNET_AMOUNT`
(default `0.01`). The
[smoke tests](../../docs/smoke-tests.md) page covers the other targets, such as
Permit2 on Base Sepolia.

It has been run: [`0xf3288399…`](https://sepolia.basescan.org/tx/0xf3288399e31eab683f9bced802fad2dcf44072f93e1aa51223a0f8398e7668e8)
settled 0.01 USDC on 2026-08-22.

It is deliberately outside `npm test` and `npm run test:e2e`: both of those
must stay deterministic and offline.

## Going to mainnet

`eip155:8453` needs more than a changed network id: an explicit
`allowMainnet`, an authenticated facilitator (or
`allowUnauthenticatedFacilitator`), HTTPS, a non-development `payTo` and the
canonical USDC. All of it is checked at config load. See
[docs/configuration.md](../../docs/configuration.md).
