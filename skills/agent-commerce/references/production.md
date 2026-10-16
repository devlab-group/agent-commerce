# Production

Everything here is a proposal for the user to carry out. Do not deploy, change
servers or enable mainnet yourself, and do not proceed without explicit
confirmation. Mainnet moves real funds.

## Before exposing the gateway

- **Set `server.adminToken: ${ADMIN_TOKEN}`.** The receipts and events routes
  hold payer addresses, amounts and transaction hashes. Without a token they
  return 404; with one they need `Authorization: Bearer <token>`.
- **Terminate TLS in a reverse proxy** that forwards to the gateway on
  `127.0.0.1` and keeps the client's `Host` header. Set
  `merchant.publicBaseUrl` to the public `https://` URL: requests whose host
  matches neither it nor a loopback name get 403.
- **Rate-limit at the proxy or edge.** The gateway has no rate limiting, and a
  free resource proxies to the API at whatever rate callers choose.
- **Keep `storage.receipts.path` on persistent storage** and back it up. It
  holds the receipts and the replay records that stop a payment proof from
  being used twice.
- **Close the bypass** described in SKILL.md step 4 on the production host too.

## Mainnet opt-ins

For a mainnet offer of any chain family (EVM, Solana or NEAR), validation
requires:

| Setting                                                            | Why                                                         |
| ------------------------------------------------------------------ | ----------------------------------------------------------- |
| `allowMainnet: true`                                               | mainnet is never a default                                  |
| `facilitator.mode: remote` with an `https` `url`                   | a local facilitator needs a funded gas key in-process       |
| `allowUnauthenticatedFacilitator: true` when `auth.type` is `none` | explicit consent to unauthenticated settlement requests     |
| a valid `payTo` outside the well-known development addresses       | the user must confirm ownership; validation cannot prove it |
| `asset`: USDC, or another EVM token with explicit metadata for x402       | MPP, Solana and NEAR require USDC                           |

For USDC on built-in EVM networks, configured `assetName` and `assetVersion`
must match the registry's defaults; Base uses `"USD Coin"` and `"2"`.
EIP-3009 signatures depend on these domain values.

```yaml
payments:
  x402:
    enabled: true
    network: eip155:8453
    rpcUrl: ${X402_RPC_URL}
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    assetName: "USD Coin"
    assetVersion: "2"
    assetDecimals: 6
    payTo: ${MERCHANT_WALLET}
    maxTimeoutSeconds: 600
    allowMainnet: true
    facilitator:
      mode: remote
      url: https://api.cdp.coinbase.com/platform/v2/x402
      auth:
        type: cdp
        apiKeyId: ${CDP_API_KEY_ID}
        apiKeySecret: ${CDP_API_KEY_SECRET}
```

`auth.type: cdp` needs the `@coinbase/x402` peer. For an unauthenticated
facilitator, see
[examples/base-mainnet-payai](https://github.com/devlab-group/agent-commerce/tree/master/examples/base-mainnet-payai).
After the change, `npx --no -- agent-commerce doctor --env-file .env` prints
`LIVE MAINNET MODE - REAL FUNDS`.

## Running as a service

`start` runs in the foreground. Set `NODE_ENV=production` for JSON logs on
stdout; development logs use `pino-pretty` when it is installed. `LOG_LEVEL`
sets the level, overriding the silent default in `NODE_ENV=test`. Settlement
banners stay plain text. SIGTERM and SIGINT close the server, AP2 providers
and receipt store. A clean shutdown exits 0; a shutdown error exits 1.
With systemd:

```ini
[Unit]
Description=Agent Commerce Gateway
After=network-online.target

[Service]
WorkingDirectory=/srv/agent-commerce
Environment=NODE_ENV=production
ExecStart=/srv/agent-commerce/node_modules/.bin/agent-commerce start --config /srv/agent-commerce/config.yaml --env-file /srv/agent-commerce/.env
Restart=on-failure
User=agent-commerce

[Install]
WantedBy=multi-user.target
```

The `.env` file must be readable only by the service user. `WorkingDirectory`
anchors relative paths such as `./data/receipts.sqlite`, and `node` must be on
the service's `PATH`.
