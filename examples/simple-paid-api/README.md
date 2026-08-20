# Example: simple-paid-api

The smallest possible integration: **one existing HTTP endpoint, fronted by
the gateway, paywalled with x402**. No free tier, no MCP — copy
`config.yaml`, point `backend.url` at your API, and this is a
complete integration.

`config.yaml` in this directory validates as-is, with no environment
variables set, against the real config loader (`src/config`).
The commands below run it for real against this repo's local demo stack
(Anvil + MockUSDC + the demo merchant API), reusing the pieces the root
`README.md` quickstart already sets up.

## Run it

From the repository root:

```bash
# 1. Local chain + mock USDC (once per session)
npm run chain:start
npm run chain:deploy

# 2. The "existing backend" this example fronts
npm run dev:merchant

# 3. The gateway, pointed at THIS example's config instead of the root one
AGENT_COMMERCE_CONFIG=examples/simple-paid-api/config.yaml \
  X402_ASSET=$(node -p "require('./.deploy/local.json').asset") \
  npm run dev:gateway

# 4. In another terminal: verify the config and the running stack
npm run agent-commerce -- validate --config examples/simple-paid-api/config.yaml
npm run agent-commerce -- doctor --config examples/simple-paid-api/config.yaml

# 5. Buy the one resource this example exposes
curl -i http://localhost:8080/api/resources/premium_report/invoke -X POST
# -> 402 Payment Required, with a PaymentRequiredEnvelope challenge.
# A real buyer completes the challenge with `createPaymentProof`
# (`src/payments/x402/client.ts`) — see `npm run demo:agent`
# (demo/agent) for a full worked example of that flow.
```

## What this demonstrates

- A resource with **no `input` schema fields at all** still gets an explicit,
  closed schema (`properties: {}, additionalProperties: false`) rather than
  omitting `input` — an omitted schema accepts arbitrary caller input.
- `protocols.mcp.enabled: false` and `expose: [http]` — this resource is not
  reachable over MCP at all, just HTTP.
- `payments.x402.facilitator` uses Anvil's well-known local dev account #0
  (never fund it) and `payTo` is account #1 — the same layout
  `scripts/chain/deploy.ts` uses, so the local dev chain settles for real.

## Config validates standalone

```bash
npm run agent-commerce -- validate --config examples/simple-paid-api/config.yaml
```

passes with **no environment variables set at all** — every `${VAR:-default}`
falls back to a value that works against the local demo stack.
