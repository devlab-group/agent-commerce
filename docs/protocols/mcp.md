# MCP

The MCP endpoint supports `2026-07-28`. The SDK's stateless fallback also
accepts 2025-era clients that use `initialize`. `server/discover` advertises
only `2026-07-28`.

Resources with `expose: [mcp]` become MCP tools:

- tool name: resource id;
- description: resource description, plus price and proof instructions when
  paid, and authorization instructions when the resource requires it;
- input schema: canonical resource schema plus an optional `_payment` string
  for a paid resource and an optional `_authorization` object
  (`{ method, payload }`) for a resource that requires authorization.

Calling an unknown tool returns JSON-RPC error `-32602`. For requests
without modern MCP headers, malformed `tools/call` params such as a non-string
`name` or non-object `arguments` return the same code with a short message.
The SDK handles requests carrying `Mcp-Method` or a `MCP-Protocol-Version` of
`2026-07-28` or later.

Only `2025-03-26` has JSON-RPC batches. A batch whose `MCP-Protocol-Version`
names another revision gets HTTP 400 and `-32600`; the SDK serves a batch sent
without that header. `tools/list` is not paginated, so a `cursor` gets
`-32602`. Under `2026-07-28` the list carries `ttlMs: 60000` and
`cacheScope: "public"`. The adapter's own transport errors use `-32600` for a
405 or an unreadable body and `-32603` for a 500 or 503.

## Payment over MCP

A paid tool accepts a proof in the gateway's `_payment` argument or the
selected rail's MCP `_meta` carrier. The latter lets x402 and MPP clients
use their native payment format:

| Rail | Challenge                                                                                | Proof                                                                        | Delivered result                   |
| ---- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------- |
| x402 | v2 `PaymentRequired` in `structuredContent`, `content[0].text` and `_meta["x402/error"]` | `_meta["x402/payment"]`, a `PaymentPayload` object or its base64 JSON string | `_meta["x402/payment-response"]`   |
| MPP  | `_meta["org.paymentauth/payment-required"]` with the challenges                          | `_meta["org.paymentauth/credential"]`, a credential object                   | `_meta["org.paymentauth/receipt"]` |

The x402 MCP transport defines an object proof. The gateway also emits challenges in
`_meta["x402/error"]` and accepts base64 string proofs used by the `cloudflare/agents`
client; that client has not been tested here. An undecodable string gets `PAYMENT_INVALID`
and a fresh challenge. The MPP credential and receipt carriers follow
`draft-payment-transport-mcp-00`.

If both carriers are present, the rail's `_meta` proof wins. A placeholder
in `_payment` therefore cannot break a client wrapper's paid retry. Tool
descriptions and payment-required messages name both carriers.

The MPP draft uses JSON-RPC errors `-32042` for challenges and `-32043` for
refusals. This gateway puts both in tool-result `_meta`, which `mppx` accepts
but the draft does not define. MCP `2026-07-28` reserves `-32042` for protocol
use. The gateway reads payment `_meta` only inside `params` and does not
advertise payment support in its capabilities.

Without a proof, the tool returns `isError: true` and the gateway's payment-required
envelope in `structuredContent`. For x402, the v2 `PaymentRequired` fields appear
alongside that envelope so x402 clients can read them:

```jsonc
{
  "x402Version": 2,
  "resource": { /* v2 resource descriptor */ },
  "accepts": [ /* x402 payment requirements */ ],
  "status": "payment-required",
  "code": "PAYMENT_REQUIRED",
  "requestId": "...",
  "resourceId": "market_report",
  "message": "Payment of 0.01 USDC is required for resource \"market_report\". …",
  "payment": {
    "provider": "x402",
    "version": "2",
    "amount": "0.01",
    "currency": "USDC",
    "destination": "0x…",
    "network": "eip155:84532",
    "asset": "0x…",
    "expiresAt": "…",
    "accepts": [ /* provider-native requirements */ ],
    "envelope": { /* provider-native challenge document */ }
  }
}
```

For x402, `envelope` is the complete v2 `PaymentRequired` document and
`accepts` is its requirements list. A `_payment` retry carries the base64 proof.

For MPP, `envelope.wwwAuthenticate` is the serialized `WWW-Authenticate` value
and `envelope.challenges` holds the challenge objects. A `_payment` retry
carries the complete `Authorization: Payment ...` credential.

When the pipeline supplies a retry challenge, a 402 refusal includes it in
the rail's format. The x402 challenge carries the reason in `error`, in both
`structuredContent` and `_meta["x402/error"]`. MPP adds a `problem` with its
problem type, a `detail` sentence and the reason token in `reason`. An x402
settlement failure or a backend failure after settlement also includes
`_meta["x402/payment-response"]`. Every failure retains the gateway's error
envelope in `structuredContent`.

For payment-required and error results, `content[0].text` is a JSON copy of
`structuredContent`; `content[1].text` is a sentence for readers. Unexpected
exception messages and stack traces are omitted.

## MCP exclusions

The adapter does not implement MCP resources, prompts, sampling, completions,
elicitation, roots, logging, tasks or tool-list-change notifications. It has
no MCP authorization, sessions, subscriptions, pagination or HTTP+SSE transport.
The gateway, rather than the MCP adapter, enforces Host and Origin checks.

The MCP adapter maps payment carriers and results. It does not verify or
settle payments or call merchant backends.
