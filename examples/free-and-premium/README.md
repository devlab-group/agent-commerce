# Example: free-and-premium

The most common real shape for a merchant onboarding this gateway: a **free**
resource that proves the gateway genuinely fronts your existing API, plus a
**paid** resource behind x402 — both exposed over HTTP and MCP.

`config.yaml` in this directory validates as-is, with no environment
variables set, against the real config loader (`src/config`).
The commands below run it for real against this repo's local demo stack.

## Run it

From the repository root:

```bash
# 1. Local chain + mock USDC (once per session)
npm run chain:start
npm run chain:deploy

# 2. The "existing backend" this example fronts
npm run dev:merchant

# 3. The gateway, pointed at THIS example's config instead of the root one
AGENT_COMMERCE_CONFIG=examples/free-and-premium/config.yaml \
  X402_ASSET=$(node -p "require('./.deploy/local.json').asset") \
  npm run dev:gateway

# 4. In another terminal: verify config and stack health
npm run agent-commerce -- validate --config examples/free-and-premium/config.yaml
npm run agent-commerce -- doctor --config examples/free-and-premium/config.yaml

# 5. Call the free resource — no payment proof needed
curl -s "http://localhost:8080/api/resources/basic_weather/invoke" \
  -X POST -H 'content-type: application/json' -d '{"city":"berlin"}'

# 6. Call the paid resource — returns 402 without a payment proof
curl -i http://localhost:8080/api/resources/premium_report/invoke -X POST
# A real buyer completes the 402 challenge with `createPaymentProof`
# (`src/payments/x402/client.ts`) — see `npm run demo:agent`
# (demo/agent) for a full worked example of that flow.
```

## What this demonstrates

- Two resources on **one gateway, one merchant backend**: `pricing.type: free`
  needs no `payments` entry; `pricing.type: fixed` requires at least one.
- Both resources declare a closed `input` schema
  (`additionalProperties: false`) — the free resource still validates its one
  field (`city`), the paid one declares an explicit empty schema rather than
  omitting `input` (an omitted schema accepts arbitrary caller input).
- `expose: [http, mcp]` on both — the same resource definition drives both
  protocol adapters; nothing protocol-specific lives in the resource itself.

## Config validates standalone

```bash
npm run agent-commerce -- validate --config examples/free-and-premium/config.yaml
```

passes with **no environment variables set at all** — every `${VAR:-default}`
falls back to a value that works against the local demo stack.
