# Config reference

The keys this skill uses. Unknown keys fail validation. The full reference is
[docs/configuration.md](https://github.com/devlab-group/agent-commerce/blob/master/docs/configuration.md).

## Top level

| Key                | Holds                                                    |
| ------------------ | -------------------------------------------------------- |
| `version`          | always `1`                                               |
| `merchant`         | `id`, `name`, `publicBaseUrl` (the URL agents use)       |
| `server`           | `port`, `host`, optional `adminToken`, `allowedOrigins`  |
| `storage.receipts` | `driver: sqlite`, `path`                                 |
| `protocols`        | `http`, `mcp` (`enabled`, `mountPath`), `a2a`, `acp`     |
| `resources`        | one entry per endpoint, keyed by resource id             |
| `payments`         | `x402` and `mpp`; write `payments: {}` when all are free |

## Environment values

`${VAR}` works in any string value, and `${VAR:-default}` adds a fallback. An
unset variable without a default fails validation, naming the variable but
never printing values. An empty value counts as set for `${VAR}`, so a blank
`MERCHANT_WALLET=` in `.env` fails later, at the key that needs a value;
`${VAR:-default}` uses the default when `VAR` is unset or empty.
`start`, `validate` and `doctor` read variables from a file with
`--env-file <path>`; a variable already set in the environment wins over the
file.

## Resources

```yaml
resources:
  get_order:
    name: Get an order
    description: Shown to agents as the tool description
    input:
      type: object
      properties:
        orderId: { type: string }
      required: [orderId]
      additionalProperties: false
    backend:
      type: http
      method: GET
      url: ${MERCHANT_API_BASE_URL}/orders/{orderId}
      timeoutMs: 10000
      headers:
        Authorization: Bearer ${BACKEND_TOKEN}
    pricing:
      type: fixed
      amount: "0.05"
      currency: USDC
    expose: [http, mcp]
    payments: [x402]
```

- **id**: the map key. It is the HTTP path segment
  (`/api/resources/<id>/invoke`) and, with `mcp` in `expose`, the MCP tool name.
- **input**: the supported JSON Schema subset is `type`, `properties`,
  `required`, `additionalProperties`, `enum` and a single schema in `items`.
  Types include objects, arrays, strings, numbers, integers, booleans and null,
  or a union of those types. Constraints such as `pattern` and `minLength`
  are ignored; config loading, including `validate`, warns about them.
  Config loading closes objects by default unless `additionalProperties` is
  explicit. Without `input`, the resource accepts only an empty object.
- **backend**: `method` is `GET`, `POST`, `PUT`, `PATCH` or `DELETE`.
  `{param}` in `url` is filled from input, URL-encoded. The remaining input
  becomes the query string for `GET` and `DELETE`, and a JSON body otherwise.
  `timeoutMs` defaults to 10000. Redirects are not followed.
- **pricing**: `{ type: free }`, or `type: fixed` with `amount` as a decimal
  string and `currency`. An x402 price on a built-in network is in `USDC` or
  `USD`.
- **expose**: any of `http`, `mcp`, `a2a`, `acp`; each must be enabled under
  `protocols`.
- **payments**: required on a paid resource, for example `[x402]`.
- **mimeType**: what the backend returns, declared in x402 challenges before
  payment; `application/json` by default. The HTTP response itself carries the
  API's own `Content-Type` when it is text. Set it, as in `mimeType: text/html`,
  only on a paid x402 resource whose API returns something else.

## x402 networks

Use a testnet until the user confirms mainnet.

| `network`                                 | Network           | Kind    |
| ----------------------------------------- | ----------------- | ------- |
| `eip155:84532`                            | Base Sepolia      | testnet |
| `eip155:421614`                           | Arbitrum Sepolia  | testnet |
| `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | Solana Devnet     | testnet |
| `near:testnet`                            | NEAR Testnet      | testnet |
| `eip155:8453`                             | Base              | mainnet |
| `eip155:1`                                | Ethereum          | mainnet |
| `eip155:137`                              | Polygon           | mainnet |
| `eip155:42161`                            | Arbitrum One      | mainnet |
| `eip155:43114`                            | Avalanche C-Chain | mainnet |
| `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | Solana            | mainnet |
| `near:mainnet`                            | NEAR              | mainnet |

Recorded public settlement runs cover Base Sepolia, Base, Solana Devnet and
Solana mainnet. NEAR remains partial: its testnet and mainnet runs used the
suite's own facilitator, rather than a hosted service. An unknown network
fails validation. A public built-in network accepts only its configured USDC
profile; copy the asset fields from a matching example in
[examples/](https://github.com/devlab-group/agent-commerce/tree/master/examples).

## Facilitator

The facilitator verifies the buyer's signed authorization and broadcasts the
transfer. Outside a local development chain, use a remote one:

```yaml
payments:
  x402:
    facilitator:
      mode: remote
      url: ${X402_FACILITATOR_URL}
      auth:
        type: bearer
        token: ${X402_FACILITATOR_TOKEN}
```

`auth.type` is `none`, `bearer` or `cdp` (Coinbase, which needs the
`@coinbase/x402` peer). `https://x402.org/facilitator` advertises Base Sepolia
and Solana Devnet with no API authentication; check its `/supported` response
and gateway readiness before relying on it. `mode: local` signs inside the
gateway and accepts only `eip155:31337`; health checks also require an Anvil
RPC response. The repository's demo supplies this local chain.
