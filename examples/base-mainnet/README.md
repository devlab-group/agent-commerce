# Example: base-mainnet — REAL FUNDS

The same gateway, settling real USDC on Base. Read
[docs/mainnet.md](../../docs/mainnet.md) first — it explains what is refused
and why, and this file assumes it.

Two things are structurally different from the local and testnet examples:

- **No `signerPrivateKey`, and no way to have one.** `facilitator.mode: local`
  is refused on mainnet: it signs with a key this process holds, which is a hot
  wallet inside the resource server. A remote facilitator broadcasts and pays
  the gas.
- **Nothing is defaulted.** Every `${VAR}` below has no fallback, so a missing
  one fails config loading rather than resolving to something plausible.

## What you need

| | |
|---|---|
| `MERCHANT_WALLET` | your wallet. Address only — the gateway never wants a merchant key. |
| `ALLOW_X402_MAINNET=true` | the explicit opt-in. Never a default. |
| `X402_FACILITATOR_URL` | https, and authenticated. There is no free mainnet facilitator. |
| CDP credentials, or a bearer token | `bearer` needs nothing installed; `cdp` pulls `@coinbase/x402`. |
| `GATEWAY_ADMIN_TOKEN` | without it the receipt routes 404 and you cannot read your own ledger. |
| A Base RPC | health checks only. A dedicated endpoint — the public one's outages become your readiness failures. |

## Validate before anything else

```bash
ALLOW_X402_MAINNET=true \
MERCHANT_WALLET=0xYourWallet \
GATEWAY_PUBLIC_BASE_URL=https://your.gateway \
GATEWAY_ADMIN_TOKEN=... \
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

`doctor` then reports the deployment as `LIVE MAINNET MODE — REAL FUNDS`.

## Proving it settles

`npm run test:mainnet`, with the variables in
[docs/mainnet.md](../../docs/mainnet.md#the-smoke-test). Every run spends real
USDC. It has not been run from this repository.
