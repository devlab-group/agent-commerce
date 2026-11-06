# Agent Commerce Gateway plugin

This plugin adds one skill, `agent-commerce`, that helps Claude put
[Agent Commerce Gateway](https://github.com/devlab-group/agent-commerce)
(npm `@devlab.group/agent-commerce`) in front of an existing HTTP API. AI
agents can then call the API's endpoints over HTTP or MCP and pay for them
with x402 stablecoin payments, which go straight to the merchant's wallet.

## What the skill does

- Reads the API project in the working directory (its stack, routes and any
  OpenAPI file), or asks for the API's base URL and endpoints.
- Asks which endpoints agents may call, which of them are paid and at what
  price in USDC, the merchant wallet address, and how to keep callers from
  bypassing the gateway. It never chooses prices.
- Creates an `agent-commerce/` directory with its own `package.json`, installs
  the gateway there, and writes `config.yaml` and `.env.example`.
- Runs the gateway's `validate`, `start` and `doctor` commands, and checks that
  an unpaid call to a paid endpoint returns HTTP 402.

## What it runs, sends and fetches

- `npm install @devlab.group/agent-commerce`, and the optional peer packages
  the configuration enables (such as `@x402/core`, `@x402/evm`, `viem` and
  `@modelcontextprotocol/server`), from the npm registry.
- The locally installed gateway CLI through `npx --no -- agent-commerce`,
  which refuses to download a missing package.
- `curl` requests to the local gateway, by default on `127.0.0.1:8080`.
- The gateway it configures calls the merchant's API, an x402 facilitator
  (by default `https://x402.org/facilitator`, which needs no credentials) and
  a chain RPC endpoint (by default `https://base-sepolia-rpc.publicnode.com`,
  the Base Sepolia testnet).

The plugin has no hooks, MCP servers or scripts of its own, and sends no data
anywhere.

## Credentials the gateway uses

The skill writes credentials only as `${VAR}` placeholders in the gateway's
`config.yaml`, and tells Claude never to ask for a secret in chat or write one
into a file, command or log. The user sets the values in the gateway's own
`.env`, which the gateway CLI reads when it runs. Each value goes only to the
party it belongs to:

| Variable | What the gateway does with it |
| --- | --- |
| `GATEWAY_SHARED_SECRET` | Optional. Sends it as the `X-Gateway-Secret` header to the merchant's own API, so that API can reject calls that bypass the gateway. |
| `BACKEND_TOKEN` | Optional. The merchant API's own credential, sent only to that API. |
| `ADMIN_TOKEN` | Protects the gateway's own receipts and events routes. The operator sends it to their gateway; the gateway does not send it anywhere. |
| `X402_FACILITATOR_TOKEN` | Optional. Bearer token for the facilitator the user configures, sent only to that facilitator. |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | Optional. Credentials for Coinbase's CDP facilitator, sent only to `api.cdp.coinbase.com`. |

## Safety rules in the skill

- It never asks for a secret in chat or writes one into a file, command or
  log. Secrets are `${VAR}` placeholders that the user fills in `.env`.
- It never generates, requests or handles a private key, seed phrase or
  wallet.
- It asks first before changing application code, overwriting or deleting
  files, deploying, or touching mainnet.

## Requirements

Node.js 22 or later, npm 10 or later, and `@devlab.group/agent-commerce`
2.2.0 or later.

## Install in Claude Code

```text
/plugin marketplace add devlab-group/agent-commerce
/plugin install agent-commerce-gateway@agent-commerce
```

## License

Apache-2.0. Source and documentation:
https://github.com/devlab-group/agent-commerce
