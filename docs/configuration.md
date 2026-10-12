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

The map key (`market_report`) is the resource id, so it must be unique. It is
the HTTP path segment and, for a resource exposed via `mcp`, the tool name,
which config load checks against MCP's tool-name rule.

Each `backend.headers` entry must be a legal HTTP header name and value. Config
load refuses one that fetch would reject, such as a value with an embedded
newline, and the error names the header but never prints its value. A
configured header wins over the same header that ACP forwards from the agent;
see [Headers sent to the merchant](protocols/acp.md#headers-sent-to-the-merchant).

`payments` orders the rails a paid resource accepts. The gateway selects the
first enabled rail in that order; it does not let each request choose a rail or
fall back after a failure. Config load rejects a paid resource with no enabled
listed rail. A resource can replace the x402 rail's offers with
[its own](#a-resources-own-offers).

`mimeType` names what the backend returns, such as `text/html` or
`text/csv; header=present`. Each x402 challenge for the resource declares it as
`resource.mimeType` before the buyer pays, `application/json` when unset. An
HTTP delivery then carries the backend's own `Content-Type` when it is text and
fits the body (see [security.md](security.md#backend-response-relay)); this
setting does not change it. Config load accepts `mimeType` only on a fixed-price
resource that lists `x402` in `payments`.

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

At request time the same rules run **before pricing**, so a request that breaks
them is refused before any payment. Two checks run only at the backend call,
which follows settlement under the `upfront` flow: a URL that
cannot be parsed, and path parameters that resolve outside the template's
literal prefix (see
[SECURITY.md](../SECURITY.md#what-the-gateway-does-not-protect-against)).

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
      type: bearer             # the only supported scheme
      token: ${ACP_BEARER_TOKEN}
    idempotency:
      path: ./data/acp-idempotency.sqlite
      retentionHours: 24       # default, and the floor
      merchantIdempotent: false  # set true only when the merchant deduplicates by Idempotency-Key
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

Each operation sends a fixed canonical envelope built from `path`, carrying
`{ checkout_session_id }`, and `body`, carrying the ACP document; the
[operation table](protocols/acp.md#checkout-operations) shows which of the two each
one sends. A cancel carries `body` only when the caller sends one, such as an
`intent_trace`. Bind it explicitly:

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
        body: { type: object, additionalProperties: true }
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

Config checks that shape at load. It rejects a resource whose schema forbids
a key the adapter may send, or requires one the operation does not always
send, before it can fail at request time. A closed cancel schema must
therefore declare `body` without requiring it, as the example above does.
`body` sets `additionalProperties: true` because load closes any object schema
that omits it; a `body` that accepts no keys is refused. A complete, validating
configuration is in [examples/acp-checkout](../examples/acp-checkout).

`retentionHours` may not go below 24: a shorter window would let a replayed
`Idempotency-Key` past an expired record and run a checkout twice. It bounds
*completed* records only. One whose merchant outcome was never learned is kept
until an operator clears it, because to the next retry, deleting it looks
exactly like the operation never having happened. The idempotency database is
its own file - it never shares a table with receipts or the x402 replay defense.

Set `merchantIdempotent: true` only if the merchant stores and replays results
under the `Idempotency-Key` the gateway derives for each checkout POST. With
this setting, the gateway releases a claim after a 5xx so the same key can be
retried, as ACP requires. Without merchant deduplication, that retry could
repeat the side effect. See [ACP idempotency](protocols/acp.md#idempotency).

The gateway forwards an `Idempotency-Key` header to the merchant on every
side-effecting checkout call, derived so that it is stable across retries, a
restart and a token rotation. See [ACP](protocols/acp.md#idempotency) for
what the merchant should do with it.

See [ACP](protocols/acp.md) for the wire contract.

## `authorization.ap2`

Experimental, off by default, and absent from a config that predates it. Full
reference, including the checkout profile and the trust model: [AP2](protocols/ap2.md).

```yaml
authorization:
  ap2:
    enabled: true
    specVersion: "0.2.0"       # the only supported value
    mode: direct               # the only supported mode
    clockSkewSeconds: 60       # default; 300 is the ceiling
    requireMandateAudience: false   # default; AP2 makes `aud` optional
    requireMandateExpiry: false     # default; AP2 makes `exp` optional
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
required per issuer rather than defaulted: a mandate that carries `aud` must
name it, so one addressed to another merchant is refused.

`requireMandateAudience` rejects a token without `aud`.
`requireMandateExpiry` rejects a mandate without `exp` on either the token or
its content. Both default to `false` because AP2 makes these claims optional.
The checkout JWT independently requires `aud` and `exp`.

A token without `iss` is matched by `kid` alone. Use distinct `kid`s across
mandate issuers; a shared `kid` makes an issuerless token ambiguous.

Refused at load: requiring `ap2` while the block is absent or disabled;
requiring it on a **free** resource, since authorization gates settlement and
there would be none; a `replay.path` shared with the receipt store or the ACP
idempotency store; and a `clockSkewSeconds` above the ceiling.

## Payments

```yaml
payments:
  x402:
    enabled: true
    network: ${X402_NETWORK} # CAIP-2; eip155:31337 locally
    rpcUrl: ${X402_RPC_URL}
    payTo: ${MERCHANT_WALLET} # merchant-controlled. NEVER the gateway's.
    # Optional on a built-in network, which settles in its USDC. Set all four
    # for another token, such as the local MockUSDC.
    asset: ${X402_ASSET} # ERC-20 with EIP-3009, unless the option uses Permit2
    assetName: ${X402_ASSET_NAME} # EIP-712 domain name
    assetVersion: ${X402_ASSET_VERSION}
    assetDecimals: ${X402_ASSET_DECIMALS}
    maxTimeoutSeconds: 120
    paymentFlow: authorization # default; or upfront
    facilitator:
      mode: local # in-process signer; refused on mainnet
      signerPrivateKey: ${X402_FACILITATOR_PRIVATE_KEY}
```

`paymentFlow` sets the order of a payment and the backend call, with the same
values under `payments.x402` and `payments.mpp`. `authorization`, the x402
default, settles only after the backend succeeds. If the backend fails, no
payment settles. `upfront`, the MPP default, settles first; a later backend
failure leaves the payment settled. MPP defaults to `upfront` because its
`charge` intent forbids running the backend before the payment is verified.
A resource with fixed pricing that lists `x402` or `mpp` can set its own
`paymentFlow`, which applies to whichever rail serves it. Configuration
rejects the field on other resources. See [x402](protocols/x402.md) for
the flow details.

Startup rejects a `payTo` that is not a plausible address or is the zero
address, and the effective destination is printed in a safe, visible form so a
presenter can confirm where money goes. `validate` checks an EVM address's
form (`0x` and 40 hex characters); gateway startup also checks the EIP-55
checksum of mixed-case addresses.

### The settlement asset

Omit the four asset fields to use the [built-in network's](#network-and-facilitator)
USDC address, EIP-712 domain and decimals. Resources using this default must
be priced in `USDC` or `USD`. `USD` treats USDC at face value, without an
exchange-rate lookup, and the payment records `USDC` (see
[payment-flow.md](payment-flow.md#amounts)).

Public built-in networks, testnet or mainnet, settle only in their USDC. On the
local chain or a declared EVM network, set `asset`, `assetName`,
`assetVersion` and `assetDecimals` together; no fields are inherited from
USDC. A [Permit2](#permit2) token needs only `asset` and `assetDecimals`.
Overrides for the default token must match its metadata. Naming the default
token's address is the same as omitting it, so those resources are priced in
`USDC` or `USD` too. Payments in another token use the resource's label.

### Permit2

For an ERC-20 without `transferWithAuthorization`, set
`assetTransferMethod: permit2` to use
[Permit2](https://github.com/Uniswap/permit2) and the x402 exact Permit2 proxy.
This EVM-only option defaults to `eip3009`. Permit2 uses its own EIP-712
domain, so `assetName` and `assetVersion` are unnecessary.

```yaml
payments:
  x402:
    network: eip155:31337
    payTo: ${MERCHANT_WALLET}
    asset: ${TOKEN_ADDRESS}
    assetDecimals: 18
    assetTransferMethod: permit2
```

Before paying, the buyer approves the Permit2 contract,
`0x000000000022D473030F116dDEE9F6B43aC78BA3`, to spend the token. The gateway
sends no approval and accepts no gas-sponsoring extension. Without that
allowance it answers [412 Precondition Failed](protocols/http.md).

Other tokens require the local chain or a declared network, as above.
Health checks require code at Permit2 and the proxy,
`0x402085c248EeA27D92E8b30b2C58ed07f9E20001`. For a remote facilitator they
check only that it advertises `exact` on the network, not that it settles
Permit2.

### Solana

Solana options settle the network's USDC through a remote facilitator that
pays transaction fees. They require the optional peers `@x402/svm` and
`@solana/kit`, loaded only for Solana options.

```yaml
payments:
  x402:
    network: solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 # built-in Solana Devnet
    rpcUrl: ${SOLANA_DEVNET_RPC_URL}
    payTo: ${SOLANA_MERCHANT_WALLET} # no asset fields: the network's USDC
    facilitator:
      mode: remote
      url: ${X402_FACILITATOR_URL}
```

- `payTo` is the merchant's wallet; its USDC token account must already exist.
  The SDK client does not create it, and health fails without it.
- Each offer names the facilitator's fee payer, read from its `/supported`
  response. Without one, readiness fails and no challenge is built.
- Health checks that the RPC's genesis hash matches the network id, that the
  mint has the configured decimals, and that the facilitator lists the network
  with a fee payer.
- A transaction expires with its blockhash, about 60 to 90 seconds after the
  buyer signs. The default `authorization` flow settles after the backend, so
  use `upfront` for a handler that can take longer.

### NEAR

NEAR options settle the network's NEP-141 USDC through a remote facilitator.
The buyer signs a NEP-366 delegate action containing one `ft_transfer`; the
facilitator's relayer submits it and pays gas. The buyer needs no NEAR for
payment fees, but an implicit account must first receive NEAR to exist.
The optional peer `@x402/near` loads only for NEAR options.

```yaml
payments:
  x402:
    network: near:testnet # built-in NEAR Testnet
    rpcUrl: ${NEAR_TESTNET_RPC_URL}
    payTo: ${NEAR_MERCHANT_ACCOUNT} # no asset fields: the network's USDC
    facilitator:
      mode: remote
      url: ${X402_FACILITATOR_URL}
```

- `payTo` and `asset` are NEAR account IDs: named (`merchant.near`),
  subaccounts and implicit 64-hex accounts. The suffix does not select the
  network.
- `payTo` must be registered with the token for storage (NEP-145
  `storage_deposit`), or every transfer to it fails. Health fails until it is.
- The buyer signs with a full-access key, `ed25519` or `secp256k1`:
  `ft_transfer` needs one attached yoctoNEAR, which a function-call key cannot
  attach.
- Health checks that the RPC's `status` names the network's chain, that the
  token has code and the configured decimals, and that the facilitator lists
  the network.
- The signed delegate names no chain. The offer's network and the RPC the
  facilitator uses keep a proof on one network; use separate buyer keys for
  mainnet and testnet.
- The gateway reserves the access key's nonce. The SDK reference client
  retries with the same nonce until a transaction uses it. A rejected attempt,
  from a backend failure or a settlement refused before submission, settled
  nothing, so the gateway permits that retry. A delegate that expires during a
  slow backend call is refused at settlement, and the client signs again; use
  `upfront` for handlers that can outlast `maxTimeoutSeconds`.

### Several options

Use `options` to offer x402 resources on several networks or in several
tokens; the buyer pays one offer. Entries use the fields above, and a one-entry
list resolves like the direct form. Config load rejects mixed forms, empty
lists, an object in place of the list, duplicate (network, asset, `payTo`)
combinations, and mixed deployment modes (local, testnet, mainnet).

```yaml
payments:
  x402:
    networks:
      eip155:8453: { rpcUrl: ${BASE_RPC_URL} }
      eip155:137: { rpcUrl: ${POLYGON_RPC_URL} }
    options:
      - network: eip155:8453
        payTo: ${MERCHANT_WALLET}
      - network: eip155:137
        payTo: ${MERCHANT_WALLET}
```

Each network needs a distinct RPC endpoint for health checks. Set
`payments.x402.networks.<id>.rpcUrl`, or use the shared `payments.x402.rpcUrl`
as a fallback. RPC URLs must use `http://` or `https://`. Equivalent URLs,
such as those with and without a trailing slash, count as one endpoint.
All offers use the facilitator under `payments.x402`; it must advertise their
networks and scheme.

When options use default assets, price the resource in `USD` or their shared
token symbol. Decimal precision cannot exceed the least precise option.

The proof's `accepted` echo selects an offer before verification; zero or
multiple matches are rejected. AP2 binds to the selected destination, network
and asset, preventing a mandate for one offer from authorizing another.

### A resource's own offers

A paid resource's `x402.accepts` replaces the rail's offers for that resource,
matching the x402 SDK's route-level `accepts`. Rail options remain required
and serve resources without overrides. Entries use the `options` fields;
each charges the resource's `pricing`.

```yaml
resources:
  market_report:
    # backend, pricing and expose as above
    payments: [x402]
    x402:
      accepts:
        - network: eip155:137
          payTo: ${POLYGON_MERCHANT_WALLET}
```

Entries share the rail's `networks`, RPC endpoints, facilitator, mainnet
acknowledgements and deployment mode. Price validation uses the resource's
own tokens and decimals. Config load rejects empty lists, repeated entries,
and `x402.accepts` on free resources, without `x402` in `payments`, or without
`payments.x402`.

### `payments.mpp`

MPP accepts the `USDC` currency label on the local chain `eip155:31337`, Base
Sepolia `eip155:84532` and Base mainnet `eip155:8453`. It defaults to Base
Sepolia, so a local config names `eip155:31337`; `asset` selects the token
contract. The gateway builds its
settlement provider from this block, so `payments.x402` need not be enabled as a
resource rail.

```yaml
payments:
  mpp:
    enabled: true
    network: eip155:31337 # optional; defaults to eip155:84532 (Base Sepolia)
    rpcUrl: ${MPP_RPC_URL}
    asset: ${MPP_ASSET} # token contract on the selected RPC
    assetName: USDC # EIP-712 domain name
    assetVersion: '2'
    recipient: ${MERCHANT_WALLET} # merchant-controlled; not gateway-owned
    realm: api.example.com # the challenge realm, single line
    challengeSecret: ${MPP_CHALLENGE_SECRET} # minimum length 32
    challengeTtlSeconds: 300 # optional
    paymentFlow: upfront # default; or authorization
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

`network` is a CAIP-2 identifier, either built in or declared:

| `network`                                 | Network           | Kind    | Notes                                      |
| ----------------------------------------- | ----------------- | ------- | ------------------------------------------ |
| `eip155:31337`                            | Local Anvil       | local   | Anvil's default chain id; no default asset |
| `eip155:84532`                            | Base Sepolia      | testnet |                                            |
| `eip155:8453`                             | Base              | mainnet |                                            |
| `eip155:1`                                | Ethereum          | mainnet |                                            |
| `eip155:137`                              | Polygon           | mainnet |                                            |
| `eip155:42161`                            | Arbitrum One      | mainnet |                                            |
| `eip155:421614`                           | Arbitrum Sepolia  | testnet |                                            |
| `eip155:43114`                            | Avalanche C-Chain | mainnet |                                            |
| `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | Solana            | mainnet | [remote facilitator only](#solana)         |
| `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | Solana Devnet     | testnet | [remote facilitator only](#solana)         |
| `near:mainnet`                            | NEAR              | mainnet | [remote facilitator only](#near)           |
| `near:testnet`                            | NEAR Testnet      | testnet | [remote facilitator only](#near)           |

Every built-in EVM network is supported: the signing code is the same on
each, and on 2026-10-10 each network's USDC signing domain matched the chain
and Permit2 and its x402 proxy were deployed. Settlement has been demonstrated
on Base Sepolia and Base, through both EIP-3009 and Permit2, and on Solana
devnet and mainnet. NEAR has settled on testnet and mainnet through the SDK
facilitator run for the test. Every network also needs a facilitator that
lists it; health fails otherwise.

Declare another EVM network with its `kind` to select the mainnet guardrails.
Custom networks have no default asset: set all four asset fields. Support for
them is partial, since the gateway cannot check a chain and token you supply
in advance. Built-in networks cannot be redeclared; their entry may set
`rpcUrl` only.

```yaml
payments:
  x402:
    networks:
      eip155:10: { kind: mainnet, displayName: OP Mainnet }
```

Unknown IDs raise `CONFIG_INVALID` at config load. The chain ID is part of
the buyer's signed EIP-712 domain and must resolve explicitly.

`facilitator` decides who verifies and broadcasts:

```yaml
facilitator:
  mode: local # in-process signer; eip155:31337 only
  signerPrivateKey: ${X402_FACILITATOR_PRIVATE_KEY}
```

Local mode requires Anvil on `eip155:31337`. Other networks require remote mode.
A config that still pairs the local facilitator with `eip155:84532`, the id the
local chain used before, is refused with a pointer to `eip155:31337`.

```yaml
facilitator:
  mode: remote # HTTP; this gateway holds no facilitator signing key
  url: ${X402_FACILITATOR_URL}
  auth:
    type: none # bearer and cdp are also supported
```

Omitting `auth` is equivalent to `type: none`: the gateway sends no credential.
Use it only with a facilitator that accepts anonymous requests. Supported types
are `none`, `bearer` (a static token) and `cdp` (a fresh JWT per request).
The `cdp` type requires the optional `@coinbase/x402` peer. It signs each
request for `https://api.cdp.coinbase.com/platform/v2/x402`, so config load
refuses `cdp` with any other `url`.

Deployment mode - `local`, `testnet` or `mainnet` - comes from the network:
`eip155:31337` is local, and every other network is the testnet or mainnet it
names. `doctor`, `health()` and `/.well-known/agent-commerce` report it. In local
mode `health()` also requires the RPC to answer Anvil's `anvil_nodeInfo`,
because an RPC can report any chain id.

## Mainnet guardrails

A mainnet moves real money, so a config naming one must also say so. All of
these are refused at config load, before the gateway starts:

| Refused                                                   | Because                                                    |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| `allowMainnet` absent or false                            | mainnet is never a default                                 |
| `facilitator.mode: local`                                 | it puts a funded gas key in the resource server            |
| `facilitator.auth.type: none` without explicit acceptance | an unauthenticated counterparty must be acknowledged       |
| a non-HTTPS `facilitator.url`                             | authorizations and settlement results would be unencrypted |
| a well-known Anvil `payTo` or MPP `recipient`             | its private key is public                                  |
| an `asset` other than USDC on a built-in mainnet          | it could settle an unintended token                        |
| the wrong USDC `assetName` or `assetVersion`              | the buyer signs that EIP-712 domain                        |

The same rules apply to any non-local deployment where they make sense: plain
HTTP is allowed only to a local/private host, and a development `payTo` is
refused on testnet too.

`agent-commerce validate` applies the config-level guardrails. Provider
construction repeats the shared guardrails and adds RPC/key checks. `doctor`
reports the parsed configuration and, when reachable, the live provider health.

### `assetName` is the EIP-712 domain, not the symbol

Base Sepolia USDC reports `"USDC"`; Base mainnet reports `"USD Coin"`. The buyer
signs this name in the EIP-712 domain, so a mismatch would reject every payment
after signing. The network registry (`src/payments/x402/networks.ts`) pins the
domain of each built-in network's USDC, and config validation rejects a
mismatch before startup.

### Running against a public network

Working configurations live in `examples/base-sepolia/` and
`examples/base-mainnet/` (plus `examples/base-mainnet-payai/`, which uses an
unauthenticated facilitator). Additional examples cover Arbitrum Sepolia
(`examples/arbitrum-sepolia/`, not yet run), Solana devnet
(`examples/solana-devnet/`) and NEAR testnet (`examples/near-testnet/`).
`examples/multi-network-mainnet/` combines Base and Solana, which have
settled, with Polygon and Arbitrum One, which have not run.
`npm run test:testnet` and `npm run test:mainnet` drive the whole flow against
the real chains and read each settlement back from them. The testnet
suite spends test USDC and the mainnet suite real USDC; both skip themselves
without credentials and never run in CI. See [smoke tests](smoke-tests.md).

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
`pricing.type: dynamic` · a paid resource with no `payments` · a paid resource
none of whose listed rails is enabled · `expose` values outside
`[http, mcp, a2a, acp]` (UCP is planned, not supported) · `expose: [mcp]` while
`protocols.mcp.enabled` is false (likewise `a2a` and `acp`) ·
enabled A2A with no resource exposed through `a2a` · two enabled
protocol mounts that overlap · a mount that claims a route the gateway already
serves, including the A2A Agent Card and ACP discovery paths · an ACP checkout
mapping that is incomplete, names a missing or non-`acp` resource, reuses one
resource for two operations, or maps a paid one · an ACP idempotency retention
below 24 hours · an invalid or zero `payTo`/`asset`/`recipient` · an
`x402.accepts` list that is empty or on a resource that cannot use it · a
`mimeType` that is not a media type, or on a resource that is not fixed-price
with `x402` in `payments` · an MPP `challengeSecret` with length below 32 or a
multi-line `realm`.

It exits non-zero on any of them.

## Environment

`${VAR}` works in any string value, and `${VAR:-default}` supplies a fallback.
`agent-commerce start`, `validate` and `doctor` also read variables from a file
with `--env-file <path>`; a variable already set in the environment wins over
the file.
See [`.env.example`](../.env.example) for the variables the demo uses.
