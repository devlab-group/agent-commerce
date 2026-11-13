# Deploy on Railway

The "Agent Commerce Gateway" template runs one service from the [gateway image](deploy.md#the-image), with a volume at `/app/data` and a generated domain. Its definition is in `deploy/templates/railway/template.md`.

1. Open the template link, fill in `MERCHANT_WALLET` and `MERCHANT_API_URL`, and deploy. The other variables have testnet defaults and are described in the [variable reference](deploy.md#variables).
2. `ADMIN_TOKEN` is generated at deploy time and visible under the service's Variables.
3. [Verify the deployment](deploy.md#verify-a-deployment).

Apply these Railway settings:

- `RAILWAY_RUN_UID=0` runs the gateway as root inside its container so it can write the volume Railway mounts as root. The image otherwise runs as uid 1000.
- Leave the healthcheck path empty. Railway sends `Host: healthcheck.railway.app`, which the gateway rejects with 403. See [Public URL](deploy.md#public-url).
