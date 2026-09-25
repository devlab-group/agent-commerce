# Configuration

The gateway validates one `config.yaml` before startup. The file is git-ignored
and separate from the repository's [`config-demo.yaml`](../config-demo.yaml).
Start from [`config.example.yaml`](../config.example.yaml) or generate it:

```bash
npm run agent-commerce -- init
npm run agent-commerce -- validate
```

## Principles

- **Validated, not trusted.** YAML is parsed, then validated with Zod. Unknown
  keys fail rather than being ignored silently.
- **Fail before startup.** An invalid configuration stops the process with an
  actionable message naming the file, the path and what was expected.
- **Reference secrets from the environment.** `${VAR}` placeholders are
  resolved before validation. An unresolved variable names the variable but
  does not print resolved values.
- **Explicit version.** `version: 1`. A future version is rejected, not guessed.

## Top level

| Key                | Required                    | Purpose                       |
| ------------------ | --------------------------- | ----------------------------- |
| `version`          | yes                         | must be `1`                   |
| `merchant`         | yes                         | `id`, `name`, `publicBaseUrl` |
| `server`           | yes                         | `port`, `host`                |
| `storage.receipts` | yes                         | `driver: sqlite`, `path`      |
| `protocols`        | yes                         | which surfaces are enabled    |
| `resources`        | yes                         | the capabilities you expose   |
| `payments`         | when a paid resource exists | rail configuration            |
| `authorization`    | no                          | AP2 mandate verification      |

## Resources

```yaml
resources:
  market_report:
    name: Premium Market Report
    description: Latest premium market analysis.
    input: # JSON Schema for the agent-visible input
      type: object
      properties: {}
      additionalProperties: false
    backend:
      type: http
      method: GET
      url: ${MERCHANT_API_BASE_URL}/api/report
      timeoutMs: 10000 # bounded, always
      headers: # reference secrets from the environment
        Authorization: Bearer ${BACKEND_TOKEN}
    pricing:
      type: fixed # free | fixed (dynamic is rejected)
      amount: "0.01" # decimal string, display units, never a float
      currency: USDC
    expose: [http, mcp]
    payments: [x402]
```

The map key (`market_report`) is the resource id: it is the MCP tool name and
the HTTP path segment, so it must be unique and a legal tool name.

`payments` orders the rails a paid resource accepts. The gateway selects the
first enabled rail in that order; it does not let each request choose a rail or
fall back after a failure. Config load rejects a paid resource with no enabled
listed rail.

`url` supports `{param}` templating from validated input; values are
URL-encoded. Remaining input becomes query string for `GET`/`DELETE` and a JSON
body otherwise - unless `backend.inputBindings` says otherwise, below.

**Backend URLs are administrator configuration.** They are never taken from
request input, and redirects are not followed. See [security.md](security.md).

### `backend.inputBindings`

Optional. Names the top-level input properties carrying each part of the
backend request:

```yaml
    input:
      type: object
      properties:
        path:
          type: object
          properties:
            userId: { type: string }
          required: [userId]
        query:
          type: object
          properties:
            notify: { type: boolean }
        body:
          type: object
          properties:
            productId: { type: string }
      required: [path]
    backend:
      type: http
      method: POST
      url: ${MERCHANT_API_BASE_URL}/users/{userId}/orders
      inputBindings:
        path: path
        query: query
        body: body
```

Without `inputBindings`, `{param}` values come from top-level input and the
remaining fields become the query string (`GET`, `DELETE`) or entire JSON body
(`POST`, `PUT`, `PATCH`). This preserves the original mapping behavior.

**Present is explicit mode.** Each group is sourced independently, so one
operation can carry path parameters, query parameters *and* a JSON body at
once - which the leftover rule cannot express, because on a body-capable
method everything not consumed by the URL template becomes the body. Top-level
input that no binding names is **not forwarded to the backend at all**.

The names are yours; `path` / `query` / `body` is only the convention the
OpenAPI importer generates. Config load rejects, before the gateway starts:

- a binding to a property the input schema does not declare (schemas are
  closed, so it could never be supplied);
- `path` or `query` bound to something that is not an object schema;
- two locations bound to one property;
- a binding to `_payment`, which is reserved for payment proofs;
- a `body` binding on `GET` or `DELETE`, which send none;
- explicit bindings with no `path` binding while `url` is templated;
- a path group that is not in the input's `required`, or a `{param}` not
  declared and required inside it, which would make calls unservable.

At request time the same rules run **before pricing**, so a malformed request
shape can never settle a payment and then fail to reach the backend.

Generated by [`agent-commerce import openapi`](openapi-import.md); nothing
about the field is OpenAPI-specific.

## `protocols.acp`

Experimental, off by default, and absent from a config that predates it. The
block is optional; when `enabled` is `true` the rest of it is required.

```yaml
protocols:
  acp:
    enabled: true
    mountPath: /acp            # default
    auth:
      type: bearer             # the only scheme in this release
      token: ${ACP_BEARER_TOKEN}
    idempotency:
      path: ./data/acp-idempotency.sqlite
      retentionHours: 24       # default, and the floor
    checkout:
      operations:              # all five, each on its own resource
        createCheckoutSession: acp_checkout_create
        updateCheckoutSession: acp_checkout_update
        getCheckoutSession: acp_checkout_get
        completeCheckoutSession: acp_checkout_complete
        cancelCheckoutSession: acp_checkout_cancel
    discovery:                 # optional; omitted from discovery when absent
      documentationUrl: https://merchant.example.com/docs/acp
      supportedCurrencies: [usd]
      supportedLocales: [en-US]
      interventionTypes: [3ds]
```

Every mapped resource must exist, carry `expose: [acp]`, and be **free** with no
`payments` - ACP checkout carries the merchant's own purchase payment, and
charging to invoke the operation as well would put two unrelated payment layers
on one call. Each resource serves exactly one operation; a resource mapped twice
is refused.

The canonical envelope a resource receives is fixed per operation - `path`
carrying `{ checkout_session_id }`, `body` carrying the ACP document - so bind
it explicitly:

```yaml
    input:
      type: object
      properties:
        path:
          type: object
          properties:
            checkout_session_id: { type: string }
          required: [checkout_session_id]
          additionalProperties: false
        body: { type: object }
      required: [path]
      additionalProperties: false
    backend:
      type: http
      method: POST
      url: ${MERCHANT_API_BASE_URL}/checkout_sessions/{checkout_session_id}
      inputBindings:
        path: path
        body: body
```

Config checks that shape at load: a resource whose schema forbids a key the
adapter always sends, or requires one the operation never sends, is rejected
before it can fail at request time. A complete, validating configuration is in
[examples/acp-checkout](../examples/acp-checkout).

`retentionHours` may not go below 24: a shorter window would let a replayed
`Idempotency-Key` past an expired record and run a checkout twice. It bounds
*completed* records only. One whose merchant outcome was never learned is kept
until an operator clears it, because to the next retry, deleting it looks
exactly like the operation never having happened. The idempotency database is
its own file - it never shares a table with receipts or the x402 replay
defence.

The gateway forwards an `Idempotency-Key` header to the merchant on every
side-effecting checkout call, derived so that it is stable across retries, a
restart and a token rotation. See
[protocols.md](protocols.md#idempotency) for what the merchant should do with
it.

See [protocols.md](protocols.md#acp) for the wire contract.

## `authorization.ap2`

Experimental, off by default, and absent from a config that predates it. Full
reference, including the checkout profile and the trust model:
[ap2.md](ap2.md).

```yaml
authorization:
  ap2:
    enabled: true
    specVersion: "0.2.0"       # the only supported value
    mode: direct               # the only supported mode
    clockSkewSeconds: 60       # default; 300 is the ceiling
    replay:
      path: ./data/ap2-authorizations.sqlite   # its own file, never shared
    trust:
      mandateIssuers:          # who may issue a Checkout Mandate
        - issuer: https://surface.example
          audience: merchant.example
          keys:
            - kid: mandate-2026-01
              jwk: { kty: EC, crv: P-256, x: "...", y: "..." }
      checkoutIssuers:         # who may sign the merchant checkout JWT
        - issuer: https://merchant.example
          audience: agent-commerce
          keys:
            - kid: checkout-2026-01
              jwk: { kty: EC, crv: P-256, x: "...", y: "..." }
```

Then require it on a paid resource:

```yaml
resources:
  market_report:
    pricing: { type: fixed, amount: "0.01", currency: USDC }
    payments: [x402]
    authorization:
      required: [ap2]
```

Public keys only, written here by an operator. Nothing is fetched: no JWKS, no
`jku`, no `x5u`, no issuer discovery. A JWK carrying private material is
refused at load and names the key to rotate.

The two issuer lists are separate on purpose - signing the merchant's checkout
documents must not confer the power to issue mandates - and `audience` is
required per issuer rather than defaulted, because without it a mandate minted
for another merchant would verify here.

Refused at load: requiring `ap2` while the block is absent or disabled;
requiring it on a **free** resource, since authorization gates settlement and
there would be none; a `replay.path` shared with the receipt store or the ACP
idempotency store; and a `clockSkewSeconds` above the ceiling.

## Payments

```yaml
payments:
  x402:
    enabled: true
    network: ${X402_NETWORK} # CAIP-2; eip155:84532 locally
    rpcUrl: ${X402_RPC_URL}
    asset: ${X402_ASSET} # ERC-20 with EIP-3009
    assetName: ${X402_ASSET_NAME} # EIP-712 domain name
    assetVersion: ${X402_ASSET_VERSION}
    assetDecimals: ${X402_ASSET_DECIMALS}
    payTo: ${MERCHANT_WALLET} # merchant-controlled. NEVER the gateway's.
    maxTimeoutSeconds: 120
    facilitator:
      mode: local # local dev chain only
      signerPrivateKey: ${X402_FACILITATOR_PRIVATE_KEY}
```

Startup rejects a `payTo` that is not a plausible address or is the zero
address, and the effective destination is printed in a safe, visible form so a
presenter can confirm where money goes.

### `payments.mpp`

MPP accepts the `USDC` currency label on `eip155:84532`, shared by Base Sepolia
and the local development chain, and on Base mainnet `eip155:8453`. It defaults
to `eip155:84532`; `asset` selects the token contract. The gateway builds its
settlement provider from this block, so `payments.x402` need not be enabled as a
resource rail.

```yaml
payments:
  mpp:
    enabled: true
    network: eip155:84532 # optional; eip155:8453 is Base mainnet
    rpcUrl: ${MPP_RPC_URL}
    asset: ${MPP_ASSET} # token contract on the selected RPC
    assetName: USDC # EIP-712 domain name
    assetVersion: '2'
    recipient: ${MERCHANT_WALLET} # merchant-controlled; not gateway-owned
    realm: api.example.com # the challenge realm, single line
    challengeSecret: ${MPP_CHALLENGE_SECRET} # minimum length 32
    challengeTtlSeconds: 300 # optional
    facilitator:
      mode: remote
      url: ${MPP_FACILITATOR_URL}
```

`facilitator` accepts the same local and remote forms as x402. Config-level
address, facilitator and mainnet errors use the `payments.mpp` path. Provider
construction performs additional RPC/key safety checks as `x402 provider` and
uses `payTo` for the MPP recipient in those messages. While
`payments.mpp.enabled` is true, every paid resource that lists `mpp` must use
the `USDC` currency label with at most 6 fractional digits.

On `eip155:8453`, `payments.mpp` uses the same
[mainnet guardrails](#mainnet-guardrails) as x402. It requires
`allowMainnet: true`, a remote facilitator over HTTPS, canonical USDC with
`assetName: USD Coin` and `assetVersion: '2'`, a recipient that is not an Anvil
development address, and either a facilitator credential or
`allowUnauthenticatedFacilitator: true`.

## Network and facilitator

`network` is a CAIP-2 identifier and must be one this build knows:

| `network`      |              | Notes                                      |
| -------------- | ------------ | ------------------------------------------ |
| `eip155:84532` | Base Sepolia | the chain id the local dev chain also uses |
| `eip155:8453`  | Base         | mainnet; real funds                        |

Anything else is `CONFIG_INVALID` at load. The chain id is signed into the
buyer's EIP-712 domain, so an unrecognised network is never guessed at.

`facilitator` decides who verifies and broadcasts:

```yaml
facilitator:
  mode: local # in-process, dev chain only
  signerPrivateKey: ${X402_FACILITATOR_PRIVATE_KEY}
```

```yaml
facilitator:
  mode: remote # HTTP; this gateway holds no facilitator signing key
  url: ${X402_FACILITATOR_URL}
  auth:
    type: none # bearer and cdp are also supported
```

`auth` may be omitted, which means the same as `type: none` - an explicit
statement that this facilitator takes no credential, not a fallback. Supported
types are `none`, `bearer` (a static token) and `cdp` (a fresh JWT per request).
The `cdp` type requires the optional `@coinbase/x402` peer.

Deployment mode - `local`, `testnet` or `mainnet` - comes from the network and
facilitator together. Chain id 84532 identifies both the local chain and public
Base Sepolia. `doctor`, `health()` and `/.well-known/agent-commerce` report the
resolved mode.

## Mainnet guardrails

`eip155:8453` moves real money, so a config naming it must also say so. All of
these are refused at config load, before the gateway starts:

| Refused                                                    | Because                                                     |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| `allowMainnet` absent or false                             | mainnet is never a default                                  |
| `facilitator.mode: local`                                  | it puts a funded gas key in the resource server             |
| `facilitator.auth.type: none` without explicit acceptance  | an unauthenticated counterparty must be acknowledged        |
| a non-HTTPS `facilitator.url`                              | authorisations and settlement results would be unencrypted  |
| a well-known Anvil `payTo` or MPP `recipient`              | its private key is public                                   |
| an `asset` other than canonical USDC on Base               | it could settle an unintended token                         |
| the wrong USDC `assetName` or `assetVersion`               | the buyer signs that EIP-712 domain                         |

The same rules apply to any non-local deployment where they make sense: plain
HTTP is allowed only to a local/private host, and a development `payTo` is
refused on testnet too.

`agent-commerce validate` applies the config-level guardrails. Provider
construction repeats the shared guardrails and adds RPC/key checks. `doctor`
reports the parsed configuration and, when reachable, the live provider health.

### `assetName` is the EIP-712 domain, not the symbol

Base Sepolia USDC reports `"USDC"`; Base mainnet reports `"USD Coin"`. The buyer
signs this name in the EIP-712 domain, so a mismatch would reject every payment
after signing. The network registry (`src/payments/x402/networks.ts`) pins both
values, and config validation rejects a mainnet mismatch before startup.

### Running against a public network

Working configurations live in `examples/base-sepolia/` and
`examples/base-mainnet/` (plus `examples/base-mainnet-payai/`, which uses an
unauthenticated facilitator). `npm run test:testnet` and `npm run test:mainnet`
drive the whole flow against the real chains and read balances and the
transaction receipt back off them; both spend real funds, skip themselves
without credentials, and never run in CI.

## Unsupported JSON Schema keywords have a cost

The input validator supports `type`, `properties`, `required`,
`additionalProperties`, primitives and `enum`. `minLength`, `pattern`, `format`
and friends are **silently ignored**, and `agent-commerce validate` warns when a
resource schema uses one.

For a backend URL with a `{param}` template, `minLength: 1` cannot reject an
empty value because it is not enforced. The gateway separately rejects empty,
`.` and `..` path parameters before pricing, but values that only `pattern`
would exclude can reach the backend.

Validate what matters in your own API, and do not rely on a keyword the warning
told you is ignored.

## Validation rules worth knowing

`agent-commerce validate` fails on: unknown keys · missing required fields ·
unsupported `version` · unresolved `${VAR}` · duplicate resource ids ·
`pricing.type: dynamic` · a paid resource with no `payments` · a resource naming
an unconfigured or disabled payment method · `expose` values outside
`[http, mcp, a2a, acp]` (UCP is planned, not supported) · `expose: [mcp]` while
`protocols.mcp.enabled` is false (likewise `a2a` and `acp`) · two enabled
protocol mounts that overlap · a mount that claims a route the gateway already
serves, including the A2A Agent Card and ACP discovery paths · an ACP checkout
mapping that is incomplete, names a missing or non-`acp` resource, reuses one
resource for two operations, or maps a paid one · an ACP idempotency retention
below 24 hours · an invalid or zero `payTo`/`asset`/`recipient` · an MPP
`challengeSecret` with length below 32 or a multi-line `realm`.

It exits non-zero on any of them.

## Environment

`${VAR}` works in any string value, and `${VAR:-default}` supplies a fallback.
See [`.env.example`](../.env.example) for the variables the demo uses.
