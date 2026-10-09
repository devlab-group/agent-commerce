# Example: near-testnet

x402 `exact` on NEAR testnet (`near:testnet`). The buyer signs one USDC
`ft_transfer` in a NEP-366 delegate. The facilitator's relayer wraps it in a
transaction and pays gas; the payment flow needs no gateway or merchant key.
Omitting asset fields selects the built-in testnet USDC profile.

The gateway loads NEAR support only when a NEAR offer is configured:

```bash
npm install @x402/near@2.25.0
```

## What you need

|                    |                                                                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A merchant account | `NEAR_MERCHANT_ACCOUNT`, with a storage deposit on the USDC token (NEP-145 `storage_deposit`); Circle's faucet makes one when it sends USDC. Health fails without one.                       |
| A funded buyer     | testnet USDC from https://faucet.circle.com (Near Testnet) and a full-access key: the SDK facilitator refuses a delegate signed with a function-call key.                                    |
| A NEAR facilitator | `X402_FACILITATOR_URL`, one that serves `near:testnet`. FastNEAR's [hosted facilitator](https://github.com/fastnear/x402-facilitator) requires an API key: send it with `auth.type: bearer`. |

A facilitator for NEAR runs the SDK's `ExactNearScheme` from
`@x402/near/exact/facilitator` with a relayer account that holds testnet NEAR
for gas. Running a production facilitator is outside this project; the smoke
suite below runs one for the length of a test.

```bash
NEAR_MERCHANT_ACCOUNT=merchant.testnet X402_FACILITATOR_URL=https://your-facilitator \
  npm run agent-commerce -- validate --config examples/near-testnet/config.yaml
```

## Proving it settles

```bash
X402_SMOKE_TARGETS=near-testnet \
X402_NEAR_TESTNET_BUYER_ACCOUNT=buyer.testnet \
X402_NEAR_TESTNET_BUYER_PRIVATE_KEY=ed25519:... \
X402_NEAR_TESTNET_MERCHANT_ACCOUNT=merchant.testnet \
X402_NEAR_TESTNET_RELAYER_ACCOUNT=relayer.testnet \
X402_NEAR_TESTNET_RELAYER_PRIVATE_KEY=ed25519:... \
  npm run test:testnet
```

Without `X402_NEAR_TESTNET_FACILITATOR_URL`, the run starts the SDK's
facilitator on 127.0.0.1 with that relayer. It then reads the buyer's
`ft_transfer` and the token's successful receipt from the final transaction;
see [docs/smoke-tests.md](../../docs/smoke-tests.md).

It has been run: [`5tdtGLv4TB…`](https://testnet.nearblocks.io/txns/5tdtGLv4TBifK7c12hEdRuvxvNNrWjcWDH4e1ApUcE1W)
settled 0.01 USDC on 2026-10-10.
