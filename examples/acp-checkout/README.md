# Example: acp-checkout

This experimental ACP checkout adapter uses the `2026-04-17` snapshot. Each
of its five operations maps to a resource backed by the merchant's checkout
API:

| ACP operation | Route | Resource |
| --- | --- | --- |
| `createCheckoutSession` | `POST /acp/checkout_sessions` | `acp_checkout_create` |
| `updateCheckoutSession` | `POST /acp/checkout_sessions/{id}` | `acp_checkout_update` |
| `getCheckoutSession` | `GET /acp/checkout_sessions/{id}` | `acp_checkout_get` |
| `completeCheckoutSession` | `POST /acp/checkout_sessions/{id}/complete` | `acp_checkout_complete` |
| `cancelCheckoutSession` | `POST /acp/checkout_sessions/{id}/cancel` | `acp_checkout_cancel` |

`config.yaml` validates without environment variables.

The demo stack does not include this merchant checkout API. Supply a backend
that implements the ACP checkout responses at
`${MERCHANT_API_BASE_URL}/checkout_sessions...`.

## Why every resource is free

ACP checkout carries the merchant's own purchase payment, in `payment_data` on
completion. That is business input on its way to the merchant backend - it is
never converted into an Agent Commerce payment proof, and the gateway does not
also charge x402 to *invoke* the operation. A paid mapping is refused at config
load.

## Run it

From the repository root:

```bash
# Start the gateway with this example's config
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

Every checkout call needs `Authorization` and `API-Version`. A POST also needs
`Idempotency-Key`, plus `Content-Type: application/json` when it carries a body:

```bash
curl -s http://localhost:8080/acp/checkout_sessions \
  -H "Authorization: Bearer local-development-acp-token" \
  -H "API-Version: 2026-04-17" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"line_items":[{"id":"item_123"}],"currency":"usd","capabilities":{}}'
```

While its completed idempotency record is retained, repeating the same
request and `Idempotency-Key` returns the stored answer with
`Idempotent-Replayed: true` without another merchant call. Reusing the key
with a different body returns `422`.

## What is not here

Carts, feed, standalone orders, delegated payment, delegated authentication,
webhooks, the ACP MCP transport binding, request `Signature` verification, and
any ACP version other than `2026-04-17`. `/.well-known/acp.json` advertises
`services: ["checkout"]` and nothing else, and `agent-commerce doctor` prints
the full unsupported list. See [docs/protocols.md](../../docs/protocols.md#acp).
