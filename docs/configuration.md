# Configuration

One file, `config.yaml`, validated before the server starts. Start from
[`config.example.yaml`](../config.example.yaml) or generate one:

`config.yaml` is yours — it is git-ignored, and `agent-commerce init` writes it
by default. The demo stack in this repository runs its own
[`config-demo.yaml`](../config-demo.yaml) instead, so the two never collide.

```bash
npm run agent-commerce -- init
npm run agent-commerce -- validate
```

## Principles

- **Validated, not trusted.** YAML is parsed, then validated with Zod. Unknown
  keys fail rather than being ignored silently.
- **Fail before startup.** An invalid configuration stops the process with an
  actionable message naming the file, the path and what was expected.
- **Secrets by reference only.** `${VAR}` placeholders are resolved from the
  environment. An unresolved variable is an error that names the *variable* and
  never prints any resolved value.
- **Explicit version.** `version: 1`. A future version is rejected, not guessed.

## Top level

| Key | Required | Purpose |
|---|---|---|
| `version` | yes | must be `1` |
| `merchant` | yes | `id`, `name`, `publicBaseUrl` |
| `server` | yes | `port`, `host` |
| `storage.receipts` | yes | `driver: sqlite`, `path` |
| `protocols` | yes | which surfaces are enabled |
| `resources` | yes | the capabilities you expose |
| `payments` | when a paid resource exists | rail configuration |

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
      headers: # secrets by reference only
        Authorization: Bearer ${BACKEND_TOKEN}
    pricing:
      type: fixed # free | fixed (dynamic is rejected in v0.1)
      amount: "0.01" # decimal string, display units, never a float
      currency: USDC
    expose: [http, mcp]
    payments: [x402]
```

The map key (`market_report`) is the resource id: it is the MCP tool name and
the HTTP path segment, so it must be unique and a legal tool name.

`url` supports `{param}` templating from validated input; values are
URL-encoded. Remaining input becomes query string for `GET`/`DELETE` and a JSON
body otherwise.

**Backend URLs are administrator configuration.** They are never taken from
request input, and redirects are not followed. See [security.md](security.md).

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

## Network and facilitator

`network` is a CAIP-2 identifier and must be one this build knows:

| `network` | | Notes |
|---|---|---|
| `eip155:84532` | Base Sepolia | the chain id the local dev chain also uses |
| `eip155:8453` | Base | mainnet; real funds |

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
  mode: remote # HTTP; this gateway holds no key at all
  url: ${X402_FACILITATOR_URL}
  auth:
    type: none # or: type: bearer, token: ${X402_FACILITATOR_TOKEN}
```

`auth` may be omitted, which means the same as `type: none` — an explicit
statement that this facilitator takes no credential, not a fallback. Only
`none` and `bearer` exist; a facilitator requiring per-request signed
credentials (a CDP JWT, for instance) is refused rather than sent nothing.

**What this deployment is** — `local`, `testnet` or `mainnet` — is derived
from the pair, not from the network alone, because chain id 84532 is shared
between the local dev chain and public Base Sepolia. It is reported by
`doctor`, by `health()`, and at `/.well-known/agent-commerce`.

## Mainnet guardrails

`eip155:8453` moves real money, so a config naming it must also say so. All of
these are refused at config load, before the gateway starts:

| Refused | Because |
|---|---|
| `allowMainnet` absent or false | mainnet is never a default |
| `facilitator.mode: local` | the in-process signer is a hot wallet inside the resource server |
| `facilitator.auth.type: none` | an unauthenticated production facilitator |
| a non-HTTPS `facilitator.url` | authorisations and settlement results in the clear |
| a well-known Anvil `payTo` | its private key is public knowledge |
| an `asset` that is not USDC on Base | settling in an unintended token |

The same rules apply to any non-local deployment where they make sense: plain
HTTP is allowed only to a local/private host, and a development `payTo` is
refused on testnet too.

`agent-commerce validate` and `agent-commerce doctor` run exactly the checks
the gateway runs at startup — the same function, not a second copy of the
rules.

`facilitator.auth` has three types: `none`, `bearer` (a static token, needs
nothing installed) and `cdp` (Coinbase Developer Platform, which signs a fresh
JWT per request and needs the optional peer `@coinbase/x402`). Anything else is
refused at config load rather than sent nothing.

**Base Sepolia is exercised; mainnet is not.** A real payment has settled on
Base Sepolia through the public facilitator ([testnet.md](testnet.md)). Nothing
has settled on `eip155:8453` — see [mainnet.md](mainnet.md) for what the
guardrails refuse there, which are checks, not evidence.

## Unsupported JSON Schema keywords have a cost

The input validator supports `type`, `properties`, `required`,
`additionalProperties`, primitives and `enum`. `minLength`, `pattern`, `format`
and friends are **silently ignored**, and `agent-commerce validate` warns when a
resource schema uses one.

That is not merely "weaker validation". If a resource's backend URL contains a
`{param}` template, you have **no configuration-level way to reject an empty
string** for it — `minLength: 1` will not be enforced. The gateway rejects
empty, `.` and `..` path parameters itself, before any payment is taken, but
anything else you intended `pattern` to exclude will reach your backend.

Validate what matters in your own API, and do not rely on a keyword the warning
told you is ignored.

## Validation rules worth knowing

`agent-commerce validate` fails on: unknown keys · missing required fields ·
unsupported `version` · unresolved `${VAR}` · duplicate resource ids ·
`pricing.type: dynamic` · a paid resource with no `payments` · a resource naming
an unconfigured or disabled payment method · `expose` values outside
`[http, mcp]` (UCP is planned, not supported) · `expose: [mcp]` while
`protocols.mcp.enabled` is false · an invalid or zero `payTo`/`asset`.

It exits non-zero on any of them.

## Environment

`${VAR}` works in any string value, and `${VAR:-default}` supplies a fallback.
See [`.env.example`](../.env.example) for the variables the demo uses.
