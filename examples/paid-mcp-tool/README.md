# Example: paid-mcp-tool

This paid resource is exposed as an MCP tool. With
`protocols.http.enabled: false`, the gateway has no
`POST /api/resources/:id/invoke` route. Clients can still call the open MCP
endpoint; this setting controls exposure, not authentication.

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
AGENT_COMMERCE_CONFIG=examples/paid-mcp-tool/config.yaml \
  X402_ASSET=$(node -p "require('./.deploy/local.json').asset") \
  npm run dev:gateway

# Terminal 4: verify config and stack health
npm run agent-commerce -- validate --config examples/paid-mcp-tool/config.yaml
npm run agent-commerce -- doctor --config examples/paid-mcp-tool/config.yaml

# Discover it as an MCP tool (Streamable HTTP, default mount /mcp)
curl -s http://localhost:8080/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# -> "market_report_tool" appears; there is no equivalent HTTP resource route.
```

`tools/call` on `market_report_tool` goes through the same
`ExecutionPipeline` as every HTTP resource, so it returns the same 402
challenge shape when unpaid. A real buyer completes it with
`createPaymentProof` (`src/payments/x402/client.ts`); see
`npm run demo:agent` (demo/agent) for a full worked example, and
`tests/conformance/mcp` for the protocol's own test suite.

## What this demonstrates

- `protocols.http.enabled: false` while `protocols.mcp.enabled: true`: HTTP
  resource routes are off entirely, not merely unused.
- `expose: [mcp]` on the resource. Setting `expose: [http]` here would fail
  `agent-commerce validate` with `CONFIG_INVALID` (`exposed via "http" but
  protocols.http.enabled is false`).
- The resource id (`market_report_tool`) doubles as the MCP tool name, so it
  is restricted to legal MCP tool names: `A-Z`, `a-z`, `0-9`, `_`, `-` and
  `.`, 1-128 characters.
