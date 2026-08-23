# Example: base-sepolia

The same gateway as the local examples, settling **real USDC on a public
testnet** instead of on Anvil. There is no different code path — `config.yaml`
here is the local config with a different `network` and a remote facilitator.

Two things disappear compared to a local setup:

- **No `signerPrivateKey`.** With `facilitator.mode: remote` the gateway holds
  no signing key at all. The facilitator broadcasts the transfer and pays the
  gas.
- **No MockUSDC.** `asset` is Circle's real USDC on Base Sepolia,
  `0x036CbD53842c5426634e7929541eC2318f3dCF7e` — EIP-712 domain `("USDC","2")`,
  6 decimals.

The buyer's key stays with the buyer. It never appears in any config file, and
the gateway never sees it.

## What you need

|                                  |                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| A merchant address               | any address you control. `MERCHANT_WALLET`. Address only — no key, ever.                                            |
| A buyer wallet with testnet USDC | https://faucet.circle.com. The buyer needs **no ETH**: EIP-3009 is signed offline and the facilitator pays the gas. |
| A Base Sepolia RPC               | only for health checks. The public default works; a dedicated endpoint is more reliable.                            |

Unlike the other examples, this one does **not** validate with no environment
set: `MERCHANT_WALLET` has no default, because the only default available
would be an Anvil development address, and the gateway refuses one of those on
any non-local deployment. That refusal is the feature.

```bash
MERCHANT_WALLET=0xYourMerchantAddress \
  npm run agent-commerce -- validate --config examples/base-sepolia/config.yaml
```

## Run it

```bash
# 1. Your backend, or this repo's demo merchant API
npm run dev:merchant

# 2. The gateway, on Base Sepolia
MERCHANT_WALLET=0xYourMerchantAddress \
  npm run agent-commerce -- doctor --config examples/base-sepolia/config.yaml
```

`doctor` reports the deployment as `TESTNET on Base Sepolia (eip155:84532)`,
not as local — chain id 84532 belongs to both, so the facilitator is what
distinguishes them.

## Proving it settles

```bash
X402_TESTNET_BUYER_PRIVATE_KEY=0x... \
X402_TESTNET_MERCHANT_ADDRESS=0xYourMerchantAddress \
  npm run test:testnet
```

That suite asks unpaid, signs the challenge, settles through the facilitator,
and then reads the **on-chain balances and transaction receipt back from the
network** — the gateway's own report of success is not the proof. It spends
`X402_TESTNET_AMOUNT` (default `0.01`) USDC per run, and it skips itself with
an explanation when those variables are absent.

It has been run: [`0xf3288399…`](https://sepolia.basescan.org/tx/0xf3288399e31eab683f9bced802fad2dcf44072f93e1aa51223a0f8398e7668e8)
settled 0.01 USDC on 2026-08-22.

It is deliberately outside `npm test` and `npm run test:e2e`: both of those
must stay deterministic and offline.

## Going to mainnet

`eip155:8453` needs more than a changed network id — an explicit
`allowMainnet`, an authenticated facilitator, HTTPS, a non-development `payTo`
and the canonical USDC. All of it is checked at config load. See
[docs/configuration.md](../../docs/configuration.md).
