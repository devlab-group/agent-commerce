# Deploy on Zeabur

The "Agent Commerce Gateway" template runs one prebuilt service from the [gateway image](deploy.md#the-image), with a volume at `/app/data` and a Zeabur domain. Source: `deploy/templates/zeabur/agent-commerce.yaml`.

1. Open the template page and deploy. Before it is listed, run `npx zeabur@latest template deploy -f deploy/templates/zeabur/agent-commerce.yaml`.
2. Enter the domain, `Merchant wallet`, `Merchant API URL` and price. Network, RPC and facilitator are service variables with testnet defaults. All variables are described in the [variable reference](deploy.md#variables).
3. The admin token is generated and shown in the service's instructions as `ADMIN_TOKEN`.
4. [Verify the deployment](deploy.md#verify-a-deployment).

The template uses Zeabur's default TCP health check. HTTP probes using `GET` or `HEAD` on `/health` skip the Host check. Probes on `/ready` must use the public hostname or a loopback name. Requests with an `Origin` header must also pass the Origin check; see [Public URL](deploy.md#public-url).
