# Example: paid-mcp-tool

A paid resource exposed **only** as an MCP tool — `protocols.http.enabled` is
`false`, so there is no `POST /api/resources/:id/invoke` route at all for this
gateway. This is the shape for "only an MCP-speaking agent should be able to
call this, not arbitrary HTTP clients".

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
AGENT_COMMERCE_CONFIG=examples/paid-mcp-tool/config.yaml \
  X402_ASSET=$(node -p "require('./.deploy/local.json').asset") \
  npm run dev:gateway

# 4. In another terminal: verify config and stack health
npm run agent-commerce -- validate --config examples/paid-mcp-tool/config.yaml
npm run agent-commerce -- doctor --config examples/paid-mcp-tool/config.yaml

# 5. Discover it as an MCP tool (Streamable HTTP, default mount /mcp)
curl -s http://localhost:8080/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# -> "market_report_tool" appears; there is no equivalent HTTP resource route.
```

`tools/call` on `market_report_tool` goes through the same
`ExecutionPipeline` as every HTTP resource, so it returns the same 402
challenge shape when unpaid. A real buyer completes it with
`createPaymentProof` (`src/payments/x402/client.ts`) — see
`npm run demo:agent` (demo/agent) for a full worked example, and
`tests/conformance/mcp` for the protocol's own test suite.

## What this demonstrates

- `protocols.http.enabled: false` while `protocols.mcp.enabled: true` — HTTP
  resource routes are off entirely, not merely unused.
- `expose: [mcp]` on the resource — attempting `expose: [http]` here would
  fail `agent-commerce validate` with `CONFIG_INVALID` ("exposed via 'http'
  but protocols.http.enabled is false").
- The resource id (`market_report_tool`) doubles as the MCP tool name, so it
  is restricted to the MCP SDK's legal tool-name characters
  (`A-Z a-z 0-9. _ -`).

## Config validates standalone

```bash
npm run agent-commerce -- validate --config examples/paid-mcp-tool/config.yaml
```

passes with **no environment variables set at all** — every `${VAR:-default}`
falls back to a value that works against the local demo stack.
