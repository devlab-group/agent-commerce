# Railway template: Agent Commerce Gateway

Create and publish the template from Workspace settings, Templates, New Template in the owner's Railway workspace. Use the values below and `icon.png` as the icon.

## Template

| Field       | Value                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| Name        | Agent Commerce Gateway                                                                                         |
| Description | Self-hosted, non-custodial gateway that puts x402 payments in front of an existing HTTP API, over HTTP or MCP. |
| Links       | https://acg.devlab.group, https://github.com/devlab-group/agent-commerce                                       |

## Service

Create one service named `agent-commerce`.

| Setting           | Value                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| Source            | Docker image `ghcr.io/devlab-group/agent-commerce:2.7.2` (public package)                         |
| Public networking | HTTP, generate a Railway domain                                                                   |
| Volume            | mount path `/app/data`                                                                            |
| Healthcheck path  | leave empty (Railway's healthcheck `Host` is refused by the gateway, see `deploy/docs/deploy.md`) |
| Start command     | leave empty                                                                                       |

## Variables

Use these definitions in the template editor. See `deploy/docs/deploy.md#variables` for variable descriptions.

| Variable                  | Value                                     | Deployer input                                                                   |
| ------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------- |
| `MERCHANT_WALLET`         | empty                                     | required, description: "Address that receives the payments (testnet by default)" |
| `MERCHANT_API_URL`        | empty                                     | required, description: "URL of the endpoint to charge for (GET)"                 |
| `PRICE_USDC`              | `0.01`                                    | optional                                                                         |
| `X402_NETWORK`            | `eip155:84532`                            | optional                                                                         |
| `X402_RPC_URL`            | `https://base-sepolia-rpc.publicnode.com` | optional                                                                         |
| `X402_FACILITATOR_URL`    | `https://x402.org/facilitator`            | optional                                                                         |
| `ADMIN_TOKEN`             | `${{secret(48)}}`                         | generated                                                                        |
| `GATEWAY_PUBLIC_BASE_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}`      | generated                                                                        |
| `PORT`                    | `8080`                                    | generated, tells Railway which port the gateway listens on                       |
| `RAILWAY_RUN_UID`         | `0`                                       | generated, Railway mounts volumes as root (see `deploy/docs/railway.md`)         |

## After deploying

Run the checks in `deploy/docs/deploy.md#verify-a-deployment` against the generated domain: `/ready` returns 200 and an unpaid invoke returns 402. The owner decides whether to offer a demo project with a dummy merchant wallet.
