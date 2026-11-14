# Demo merchant (K2)

Run the gateway image and two paid resources locally on Base Sepolia with Docker Compose. This repository does not provide a hosted demo endpoint.

| Resource        | Price     | Backend                                                                               |
| --------------- | --------- | ------------------------------------------------------------------------------------- |
| `report`        | 0.01 USDC | `api.mjs`, a static JSON report. No language model. Use it for automated buyer tests. |
| `summarize_url` | 0.02 USDC | the n8n workflow `deploy/n8n/summarize-url.json` (optional service, see below)        |

Payments settle through the public facilitator `https://x402.org/facilitator`, which requires no credentials. Your `MERCHANT_WALLET` receives the payments as `payTo`.

## Run

```sh
export MERCHANT_WALLET=0xYourBaseSepoliaAddress
export ADMIN_TOKEN="$(openssl rand -hex 32)"
export GATEWAY_SHARED_SECRET="$(openssl rand -hex 32)"
docker compose up -d
curl -s localhost:8080/ready
curl -si -X POST localhost:8080/api/resources/report/invoke -H 'content-type: application/json' -d '{}' | head -1
```

An unpaid call returns `402`; its `PAYMENT-REQUIRED` header names `eip155:84532`, the Base Sepolia USDC contract `0x036CbD53842c5426634e7929541eC2318f3dCF7e` and your wallet. `GATEWAY_HOST_PORT` changes the published port (default 8080). `GATEWAY_PUBLIC_BASE_URL` defaults to `http://localhost:8080`.

To pay, a buyer needs Base Sepolia test USDC from https://faucet.circle.com and an x402 client with a signer for that wallet.

## How the backends stay private

The demo API has no published port. The gateway calls `http://api:3001` over the default Compose network.

The optional n8n service fetches URLs supplied by buyers. It joins only the separate `n8n` network, shared with the gateway, and has no direct Compose network connection to the demo API. Its UI is published on the host's loopback address at port 5678. n8n can still reach the gateway, host and internet; see the URL check's limits in [docs/n8n.md](../docs/n8n.md#limits).

## summarize_url with n8n

```sh
docker compose --profile n8n up -d
```

Open http://localhost:5678, create the owner account, then follow [docs/n8n.md](../docs/n8n.md): import `deploy/n8n/summarize-url.json`, create the Header Auth credential `X-Gateway-Secret` with the value of `GATEWAY_SHARED_SECRET`, attach a chat model credential and activate the workflow. The gateway reaches it at `http://n8n:5678/webhook/summarize-url`; set `N8N_WEBHOOK_URL` to use another n8n instance.

## Payment flow

`config.yaml` uses the default `paymentFlow: authorization`: the gateway verifies the buyer's authorization, calls the backend, then settles if it returns 2xx. Use `upfront` for a workflow with side effects.

`docker compose down` stops the stack; add `-v` to delete the receipt store and the n8n data.
