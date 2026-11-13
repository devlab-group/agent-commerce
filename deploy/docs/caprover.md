# Deploy on CapRover

The `agent-commerce` one-click app runs the [gateway image](deploy.md#the-image) with the starter configuration and a persistent volume at `/app/data`. Source: `deploy/templates/caprover/`.

1. In the CapRover dashboard, open Apps, then One-Click Apps/Databases, and select Agent Commerce Gateway. Before the app is listed, select `>> TEMPLATE <<` and paste `deploy/templates/caprover/public/v4/apps/agent-commerce.yml`.
2. Fill in the form. `Merchant Wallet` and `Merchant API URL` are required; the other fields have testnet defaults. Each field is described in the [variable reference](deploy.md#variables).
3. Deploy, then enable HTTPS under HTTP Settings of the new app. The gateway announces `https://<app>.<root domain>` as its public URL.
4. [Verify the deployment](deploy.md#verify-a-deployment).

Installation generates an admin token. Find it as `ADMIN_TOKEN` under the app's Environment Variables.
