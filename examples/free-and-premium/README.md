# Example: free-and-premium

This example puts a free weather resource and an x402-paid report on the
same gateway. Both call the merchant API and are exposed over HTTP and MCP.

`config.yaml` validates without environment variables, but its default
`X402_ASSET` is a placeholder. The gateway command supplies the deployed
MockUSDC address from `.deploy/local.json`. The commands use the local demo
stack.

## Run it

From the repository root:

```bash
# Terminal 1: the local chain, which stays in the foreground
npm run chain:start

# Terminal 2: mock USDC, then the demo merchant API (also foreground)
npm run chain:deploy
npm run dev:merchant

# Terminal 3: the gateway with this example's config
AGENT_COMMERCE_CONFIG=examples/free-and-premium/config.yaml \
  X402_ASSET=$(node -p "require('./.deploy/local.json').asset") \
  npm run dev:gateway

# Terminal 4: verify config and stack health
npm run agent-commerce -- validate --config examples/free-and-premium/config.yaml
npm run agent-commerce -- doctor --config examples/free-and-premium/config.yaml

# Call the free resource (no payment proof needed)
curl -s "http://localhost:8080/api/resources/basic_weather/invoke" \
  -X POST -H 'content-type: application/json' -d '{"city":"berlin"}'

# Call the paid resource (402 without a payment proof)
curl -i http://localhost:8080/api/resources/premium_report/invoke -X POST
# A real buyer completes the 402 challenge with `createPaymentProof`
# (`src/payments/x402/client.ts`); see `npm run demo:agent`
# (demo/agent) for a full worked example of that flow.
```

## What this demonstrates

- Both resources use one gateway and merchant backend. The free resource
  needs no `payments` entry; fixed pricing requires a payment method.
- Both resources declare a closed `input` schema
  (`additionalProperties: false`). The free resource still validates its one
  field (`city`), the paid one declares an explicit empty schema rather than
  omitting `input` (an omitted schema accepts arbitrary caller input).
- `expose: [http, mcp]` on both: the same resource definition drives both
  protocol adapters; nothing protocol-specific lives in the resource itself.
