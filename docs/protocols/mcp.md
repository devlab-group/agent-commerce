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

On a resource with [`idempotency.redelivery`](../configuration.md#resources)
(experimental), x402 can redeliver a stored result for the same
[payment identifier](x402.md#payment-identifier) and input. The result includes
the original `_meta["x402/payment-response"]` and sets `redelivered: true` in
its `agent-commerce/delivery` summary. An exact resend retrieves the stored
result without verification until retention ends; other proofs are verified
first. The proof contains the identifier, so keep it out of logs. If the
resource requires a mandate, include the same `_authorization`. Refusals with a
`payment_identifier_*` reason return the error envelope without a challenge or
`_meta["x402/error"]`. Only an in-flight refusal sets `retryable: true` and
`details.retryAfterSeconds: 1`. MPP calls carry no retry key
([mpp.md](mpp.md#idempotency-key)). See
[retry after a lost response](../payment-flow.md#retry-after-a-lost-response).

For payment-required and error results, `content[0].text` is a JSON copy of
`structuredContent`; `content[1].text` is a sentence for readers. Unexpected
exception messages and stack traces are omitted.

## MCP Registry listing

Experimental. The [MCP Registry](https://registry.modelcontextprotocol.io)
is a public catalog of MCP servers in preview. Use the CLI to export a listing,
then publish it:

1. Set [`protocols.mcp.registry`](../configuration.md#protocolsmcpregistry)
   and an HTTPS `merchant.publicBaseUrl`.
2. Run `agent-commerce export mcp-registry`. It loads and validates the full
   config as `start` does, so required `${VAR}` placeholders must resolve. It
   writes `server.json` with the 2025-12-11 `$schema`, your `name`, `description`
   and `version`, and one `streamable-http` remote at
   `<publicBaseUrl><protocols.mcp.mountPath>`.
   Use `--output` to choose another path and `--force` to replace an existing
   file. The command writes nothing and names the key to change when MCP is
   disabled, the registry block is missing, or the URL uses a scheme other than
   HTTPS or names `localhost`, `127.0.0.1` or a `.localhost` host.
3. Log in and publish with the registry's `mcp-publisher` CLI. The namespace
   determines the required ownership proof: `io.github.<user>/` needs GitHub
   authentication; a reverse-DNS namespace such as `com.example/` needs a DNS
   TXT record or a `/.well-known/mcp-registry-auth` file on `example.com`.
   The gateway does not serve that file. See the registry's
   [authentication guide](https://github.com/modelcontextprotocol/registry/blob/115f85225c9fac5281d8a2dc8551cf49b004d2f9/docs/modelcontextprotocol-io/authentication.mdx).
4. Run `agent-commerce doctor --registry` to compare the published listing
   with your config.

The listing's version comes from `protocols.mcp.registry.version`, independently
of the package version. The registry recommends semantic versions and uses
their ordering to choose the latest. Publishing a prerelease such as `1.2.3-1`
after its release, `1.2.3`, does not make it the latest. If your config names
that prerelease, `doctor --registry` reports a version difference.

Several server names may list the same remote URL; the URL alone does not
prove who runs the server. `doctor --registry` looks up the configured name
only and reports a response with another name as a difference in `name`.

## Pins

<!-- support-record:begin pins -->

| Pin                            | Value                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pinned revision                | MCP `2026-07-28` and `2025-11-25`                                                                                                                                  |
| Upstream source                | [`modelcontextprotocol/modelcontextprotocol@05aeb07b`](https://github.com/modelcontextprotocol/modelcontextprotocol/tree/05aeb07b2db0c02adc4813a7c09f208ca8774152) |
| Declared stable upstream       | yes                                                                                                                                                                |
| Upstream wording               | "Current: the current protocol version, which is ready for use and may continue to receive backwards compatible changes" (read 2026-11-17)                         |
| `@modelcontextprotocol/server` | `2.3.0`, optional peer                                                                                                                                             |
| `@modelcontextprotocol/client` | `2.3.0`, tests only                                                                                                                                                |
| `@modelcontextprotocol/sdk`    | `1.32.0`, tests only                                                                                                                                               |

<!-- support-record:end -->

## MCP exclusions

The MCP descriptor in `GET /.well-known/agent-commerce` lists these names in
`unsupported`:

<!-- support-record:begin exclusions -->

- `resources`
- `prompts`
- `sampling`
- `completions`
- `elicitation`
- `roots`
- `logging`
- `notifications/tools/list_changed`
- `tasks`
- `dns-rebinding-protection`: The adapter relies on the gateway's `onRequest` hook to validate Host and Origin for the MCP mount.
- `authorization`
- `sessions`
- `subscriptions`
- `pagination`
- `HTTP+SSE transport`
- `MPP payment-required as JSON-RPC error -32042`: mppx reads challenges from the tool result's `_meta`.
- `MPP verification failure as JSON-RPC error -32043`: mppx reads refusals from the tool result's `_meta`.

<!-- support-record:end -->

The MCP adapter maps payment carriers and results. It does not verify or
settle payments or call merchant backends.
