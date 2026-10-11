# Example: solana-devnet

x402 `exact` on Solana devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`). The
buyer signs a USDC transfer. The facilitator adds its fee payer signature and
broadcasts it, so the gateway and the merchant hold no key. The config leaves
out the asset fields, so payments settle in Circle's devnet USDC mint.

The gateway loads Solana support only when a Solana offer is configured:

```bash
npm install @x402/svm@2.25.0 @solana/kit@5.5.1
```

## What you need

|                      |                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| A merchant wallet    | `SOLANA_MERCHANT_WALLET`. Its USDC token account must exist; send it any amount of devnet USDC once. |
| A funded buyer       | devnet USDC from https://faucet.circle.com. No SOL: the facilitator pays the fee.                    |
| A Solana facilitator | one whose `/supported` lists the devnet network. On 2026-10-07 x402.org's and PayAI's did.           |

```bash
SOLANA_MERCHANT_WALLET=YourWalletAddress \
  npm run agent-commerce -- validate --config examples/solana-devnet/config.yaml
```

Run it as in the [base-sepolia](../base-sepolia/README.md) example, with
`AGENT_COMMERCE_CONFIG=examples/solana-devnet/config.yaml`. A handler that can
take longer than about a minute should use `paymentFlow: upfront`: the signed
transaction's blockhash expires before an `authorization` flow settles it.

## Proving it settles

```bash
X402_SMOKE_TARGETS=solana-devnet \
X402_SOLANA_DEVNET_BUYER_SECRET_KEY='[...]' \
X402_SOLANA_DEVNET_MERCHANT_ADDRESS=YourWalletAddress \
  npm run test:testnet
```

The buyer key is the 64-byte secret key, as the JSON array `solana-keygen`
writes or the base58 string a wallet exports. The run reads the token balance
changes from the confirmed transaction itself; see
[docs/smoke-tests.md](../../docs/smoke-tests.md).

It has been run: [`5289xbeyHJ…`](https://explorer.solana.com/tx/5289xbeyHJPX1vX9DsLwGGJaGJJCH45qUtArhoTyxdgmWbXqZSjVPuJ3jyyLG4VrT9mFTCkLKhcoNfb1tuJ5qheb?cluster=devnet)
settled 0.01 USDC on 2026-10-10.
