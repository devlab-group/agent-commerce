# Example: acp-checkout

The **Agentic Commerce Protocol** checkout service, pinned to the stable
`2026-04-17` snapshot and **experimental**. Five ACP operations, each mapped to
one canonical resource that fronts the merchant's existing checkout API:

| ACP operation | Route | Resource |
| --- | --- | --- |
| `createCheckoutSession` | `POST /acp/checkout_sessions` | `acp_checkout_create` |
| `updateCheckoutSession` | `POST /acp/checkout_sessions/{id}` | `acp_checkout_update` |
| `getCheckoutSession` | `GET /acp/checkout_sessions/{id}` | `acp_checkout_get` |
| `completeCheckoutSession` | `POST /acp/checkout_sessions/{id}/complete` | `acp_checkout_complete` |
| `cancelCheckoutSession` | `POST /acp/checkout_sessions/{id}/cancel` | `acp_checkout_cancel` |

`config.yaml` in this directory validates as-is, with no environment variables
set, against the real config loader (`src/config`).

The merchant API this fronts is **not** part of the demo stack: this example
assumes a backend that already implements the ACP checkout shapes at
`${MERCHANT_API_BASE_URL}/checkout_sessions...`. Point it at yours.

## Why every resource is free

ACP checkout carries the merchant's own purchase payment, in `payment_data` on
completion. That is business input on its way to the merchant backend - it is
never converted into an Agent Commerce payment proof, and the gateway does not
also charge x402 to *invoke* the operation. A paid mapping is refused at config
load.

## Run it

From the repository root:

```bash
# The gateway, pointed at THIS example's config
AGENT_COMMERCE_CONFIG=examples/acp-checkout/config.yaml npm run dev:gateway

# In another terminal
npm run agent-commerce -- validate --config examples/acp-checkout/config.yaml
npm run agent-commerce -- doctor --config examples/acp-checkout/config.yaml
```

## Call it

Discovery is public:

```bash
curl -s http://localhost:8080/.well-known/acp.json
```

Every checkout call needs three headers, and POSTs need a fourth:

```bash
curl -s http://localhost:8080/acp/checkout_sessions \
  -H "Authorization: Bearer local-development-acp-token" \
  -H "API-Version: 2026-04-17" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"line_items":[{"id":"item_123"}],"currency":"usd","capabilities":{}}'
```

Retrying that exact request with the same `Idempotency-Key` replays the stored
answer with `Idempotent-Replayed: true` and never reaches the merchant twice.
Reusing the key with a different body is a `422`.

## What is not here

Carts, feed, standalone orders, delegated payment, delegated authentication,
webhooks, the ACP MCP transport binding, request `Signature` verification, and
any ACP version other than `2026-04-17`. `/.well-known/acp.json` advertises
`services: ["checkout"]` and nothing else, and `agent-commerce doctor` prints
the full unsupported list. See [docs/protocols.md](../../docs/protocols.md#acp).
