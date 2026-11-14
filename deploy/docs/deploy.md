# Deploy Agent Commerce Gateway

Deploy Agent Commerce Gateway (ACG) to add x402 payments to an existing HTTP API, exposed over HTTP or MCP. The gateway is self-hosted and non-custodial. This guide covers the container image and shared template variables. For platform instructions, see [CapRover](caprover.md), [Dokploy](dokploy.md), [Railway](railway.md), [Zeabur](zeabur.md), [n8n](n8n.md).

## The image

`ghcr.io/devlab-group/agent-commerce:<version>` contains the published npm package `@devlab.group/agent-commerce` at the same version, with pinned optional peers for x402 and MCP. The image tag equals the ACG version.

| Property  | Value                                                                     |
| --------- | ------------------------------------------------------------------------- |
| Platforms | linux/amd64, linux/arm64                                                  |
| User      | `node` (uid 1000); root owns the package and starter config               |
| Port      | 8080                                                                      |
| Health    | `HEALTHCHECK` on `GET /health` (liveness)                                 |
| Data      | `/app/data` holds the SQLite receipt store; mount a volume                |
| Config    | `/app/config.yaml` (starter), replaceable through `AGENT_COMMERCE_CONFIG` |

The starter configuration uses the variables below to expose one paid `GET` endpoint as `paid_api`, over HTTP and MCP. It accepts testnet payments. To change the resources or enable mainnet, mount your own `config.yaml` and set `AGENT_COMMERCE_CONFIG` to its path. See the [ACG configuration reference](https://github.com/devlab-group/agent-commerce/blob/master/docs/configuration.md).

```sh
docker run -d --name acg -p 8080:8080 -v acg-data:/app/data \
  -e MERCHANT_WALLET=0xYourTestnetAddress \
  -e MERCHANT_API_URL=https://api.example.com/v1/quote \
  -e ADMIN_TOKEN="$(openssl rand -hex 32)" \
  ghcr.io/devlab-group/agent-commerce:2.7.1
```

## Variables

| Variable                  | Required | Default                                   | Purpose                                                                                                                                                                                                                                                        |
| ------------------------- | -------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MERCHANT_WALLET`         | yes      | -                                         | Address that receives the payments (`payTo`). Use a wallet you control. The gateway never holds a key for it.                                                                                                                                                  |
| `MERCHANT_API_URL`        | yes      | -                                         | Full URL of the API endpoint to charge for, for example `https://api.example.com/v1/quote`. The starter calls it with `GET` and no input. Keep the API private where possible.                                                                                 |
| `ADMIN_TOKEN`             | yes      | -                                         | Bearer token for the operator routes: `/api/receipts`, `/api/events`, `/api/payment-attempts`, `/api/transactions` and manual attempt resolution at `POST /api/payment-attempts/:id/resolve`. Use at least 32 random characters. Templates generate the token. |
| `GATEWAY_PUBLIC_BASE_URL` | no       | `http://localhost:8080`                   | Public URL of the gateway. Templates set it to the platform domain. See [Public URL](#public-url).                                                                                                                                                             |
| `PRICE_USDC`              | no       | `0.01`                                    | Price per call in USDC, as a decimal string with up to 6 decimal places.                                                                                                                                                                                       |
| `X402_NETWORK`            | no       | `eip155:84532` (Base Sepolia)             | CAIP-2 EVM testnet: Base Sepolia or Arbitrum Sepolia (`eip155:421614`). Base Sepolia is the tested configuration. The image includes EVM x402 support; Solana and NEAR require packages it does not install.                                                   |
| `X402_RPC_URL`            | no       | `https://base-sepolia-rpc.publicnode.com` | RPC endpoint for health checks. Set it together with `X402_NETWORK`.                                                                                                                                                                                           |
| `X402_FACILITATOR_URL`    | no       | `https://x402.org/facilitator`            | Remote facilitator that verifies and settles payments. The default is the public testnet one and takes no credential.                                                                                                                                          |

Unset or empty optional variables use their defaults. Missing required variables fail configuration loading with a message naming the variable. Empty required values must also pass configuration validation; the Compose templates for Dokploy and the demo reject them before startup.

The starter configuration omits `allowMainnet`, so a mainnet `X402_NETWORK` fails validation. To accept mainnet payments, provide your own `config.yaml` and review the mainnet guardrails in the ACG configuration reference.

## Public URL

The gateway compares each request's `Host` hostname with `GATEWAY_PUBLIC_BASE_URL`, also accepting `localhost`, `127.0.0.1` and `::1`. Other hosts receive `403`. Set the public URL to the domain clients use, including when a proxy sits in front.

A platform health check with a different `Host` header also receives `403`. Use the image's built-in `HEALTHCHECK` or a TCP check on platforms that send their own host name.

## Data volume

Mount a volume at `/app/data` to persist receipts. The image runs as uid 1000, and a new named volume inherits that owner. On platforms that mount volumes as root, make the volume writable by uid 1000 or run the process as root. See [Railway](railway.md) for its setting.

## Verify a deployment

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://YOUR_DOMAIN/ready
curl -si -X POST https://YOUR_DOMAIN/api/resources/paid_api/invoke -H 'content-type: application/json' -d '{}' | grep -i '^payment-required'
```

`/ready` returns 200 when the receipt store, MCP adapter and payment provider checks (facilitator and RPC) pass. An unpaid invocation returns 402 with a base64-encoded `PAYMENT-REQUIRED` header. With the defaults, the decoded header names Base Sepolia (`eip155:84532`), its USDC contract (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) and your `payTo` address.

## Payment flow

The default `paymentFlow` is `authorization`: the gateway verifies the buyer's authorization, calls your API, then settles if it returns 2xx. Backend failures do not settle a payment in this mode.

For an API with side effects, set `paymentFlow: upfront` in your own configuration. Payment then settles before the API runs and remains settled if the API fails.
