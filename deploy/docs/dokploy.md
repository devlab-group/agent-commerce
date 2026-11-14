# Deploy on Dokploy

The `agent-commerce` template deploys the [gateway image](deploy.md#the-image) as a Compose service with a named volume at `/app/data` and a generated domain. Source: `deploy/templates/dokploy/blueprints/agent-commerce/`.

1. Create a project, add a service from the Templates list, and select Agent Commerce Gateway.
2. Under the service's Environment, set `MERCHANT_WALLET` and `MERCHANT_API_URL`. Compose rejects deployment with a message naming the variable if either is empty. Adjust `PRICE_USDC` if needed. All variables are described in the [variable reference](deploy.md#variables).
3. Deploy. The generated domain serves the gateway on port 8080, and `GATEWAY_PUBLIC_BASE_URL` already points to it. If you attach a different domain, update that variable.
4. [Verify the deployment](deploy.md#verify-a-deployment).

`ADMIN_TOKEN` is generated and listed in the same Environment tab.
