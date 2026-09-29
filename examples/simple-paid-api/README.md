# Example: simple-paid-api

This example charges for one existing HTTP endpoint through x402. It has no
free resource or MCP exposure. Point `backend.url` at the merchant API and
configure the payment settings for your deployment.

`config.yaml` validates without environment variables, but its default
`X402_ASSET` is a placeholder. Step 3 supplies the deployed MockUSDC address
from `.deploy/local.json`. The commands use the local demo stack: Anvil,
MockUSDC and the demo merchant API.

## Run it

From the repository root:

```bash
# 1. Local chain + mock USDC (once per session)
npm run chain:start
npm run chain:deploy

# 2. Start the demo merchant API
npm run dev:merchant

# 3. Start the gateway with this example's config
AGENT_COMMERCE_CONFIG=examples/simple-paid-api/config.yaml \
  X402_ASSET=$(node -p "require('./.deploy/local.json').asset") \
  npm run dev:gateway

# 4. In another terminal: verify the config and the running stack
npm run agent-commerce -- validate --config examples/simple-paid-api/config.yaml
npm run agent-commerce -- doctor --config examples/simple-paid-api/config.yaml

# 5. Request the paid resource without a proof (returns 402)
curl -i http://localhost:8080/api/resources/premium_report/invoke -X POST
# -> 402 Payment Required, with a PaymentRequiredEnvelope challenge.
# A real buyer completes the challenge with `createPaymentProof`
# (`src/payments/x402/client.ts`); see `npm run demo:agent`
# (demo/agent) for a full worked example of that flow.
```

## What this demonstrates

- A resource with **no `input` schema fields at all** still gets an explicit,
  closed schema (`properties: {}, additionalProperties: false`) rather than
  omitting `input`, because an omitted schema accepts arbitrary caller input.
- `protocols.mcp.enabled: false` and `expose: [http]`: this resource is not
  reachable over MCP at all, just HTTP.
- `payments.x402.facilitator` uses Anvil's well-known local dev account #0
  (never fund it) and `payTo` is account #1, the same layout
  `scripts/chain/deploy.ts` uses, so the local dev chain settles for real.
