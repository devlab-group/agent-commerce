# Example: base-mainnet (REAL FUNDS)

The same gateway, settling real USDC on Base. Read
[docs/configuration.md](../../docs/configuration.md) first. It explains what
is refused and why, and this file assumes it.

Two things are structurally different from the local and testnet examples:

- **No `signerPrivateKey`, and no way to have one.** `facilitator.mode: local`
  is refused on mainnet: it signs with a key this process holds, which is a hot
  wallet inside the resource server. A remote facilitator broadcasts and pays
  the gas.
- **Almost nothing is defaulted.** Only the port, the receipt store path and
  the RPC URL have fallbacks. Every other `${VAR}` has none, so a missing one
  fails config loading rather than resolving to something plausible.

## What you need

|                                    |                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `MERCHANT_WALLET`                  | your wallet. Address only: the gateway never takes a merchant key.                                                            |
| `ALLOW_X402_MAINNET=true`          | the explicit opt-in. Never a default.                                                                                         |
| `X402_FACILITATOR_URL`             | https, and authenticated unless you set `allowUnauthenticatedFacilitator` (see [base-mainnet-payai](../base-mainnet-payai/)). |
| CDP credentials, or a bearer token | `bearer` needs nothing installed; `cdp` pulls `@coinbase/x402`.                                                               |
| `ADMIN_TOKEN`                      | required here: it guards the receipt routes, which carry your ledger.                                                         |
| A Base RPC                         | health checks only. Use a dedicated endpoint: the public one's outages become your readiness failures.                        |

## Validate before anything else

```bash
ALLOW_X402_MAINNET=true \
MERCHANT_WALLET=0xYourWallet \
GATEWAY_PUBLIC_BASE_URL=https://your.gateway \
ADMIN_TOKEN=... \
MERCHANT_API_BASE_URL=http://localhost:3000 \
X402_FACILITATOR_URL=https://... \
CDP_API_KEY_ID=... CDP_API_KEY_SECRET=... \
  npm run agent-commerce -- validate --config examples/base-mainnet/config.yaml
```

Drop any one of those and it fails, naming the path:

```console
FAIL  CONFIG_INVALID: Unresolved environment variable "${ALLOW_X402_MAINNET}"
      referenced at config path "$.payments.x402.allowMainnet"
```

With every value set, `doctor` reports the deployment as
`LIVE MAINNET MODE - REAL FUNDS`.

## Proving it settles

```bash
export ALLOW_X402_MAINNET=true
export X402_MAINNET_BUYER_PRIVATE_KEY=0x...   # funded with USDC on Base
export X402_MAINNET_MERCHANT_ADDRESS=0x...
export X402_FACILITATOR_URL=https://...
export CDP_API_KEY_ID=...  CDP_API_KEY_SECRET=...   # optional; or X402_FACILITATOR_TOKEN
npm run test:mainnet
```

**Each successful x402 smoke run spends `X402_MAINNET_AMOUNT` (default
`0.01`) of real USDC.** The x402 suite skips itself, naming missing settings,
unless the opt-in, buyer key, merchant address and facilitator URL are set.
The facilitator credential is optional. Setting `ALLOW_MPP_MAINNET=true` also
enables the separate, paid MPP smoke suite.

It proves, in order: the guard refuses a config that has not opted in · the
deployment reports itself as live mainnet · a payment settles on Base · the
receipt carries the settlement reference and a 2xx backend status · the
resource is delivered exactly once · the same authorization presented again is
refused with no second transfer · no credential appears in anything logged.
Balances and the transaction receipt are read back from the chain.

It never runs in CI; see the [main README](../../README.md#base-mainnet) for why.
