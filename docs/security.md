# Security model

[`SECURITY.md`](../SECURITY.md) is the policy and the disclosure process. This
page is the engineering detail: what the trust boundaries are, and what we
deliberately do not defend.

## Trust boundaries

```text
  UNTRUSTED SEMI-TRUSTED TRUSTED
  ───────── ──────────── ───────
  agent input ────► gateway process ────► merchant backend
  payment proofs (validates all (administrator
  protocol traffic of the left, configured, assumed
                             holds no keys) to be yours)

                            configuration ◄──── administrator (trusted)
                            environment ◄──── operator (trusted)
```

Everything from an agent is untrusted and validated. Configuration is trusted
input supplied by whoever runs the gateway — which is why backend URLs may only
come from configuration.

## Secret handling

Never logged, never persisted, never returned:

- private keys, seed phrases, mnemonics
- `Authorization` headers and backend API secrets
- the `X-PAYMENT` header and raw payment authorisation payloads
- `signature`, `secret`, `apiKey`, `signerPrivateKey`, `adminToken` and `token`
  fields, **at the top level and one level deep** (see below)

Enforcement is pino redaction on the logger plus explicit exclusion in the
receipt store.

**The logger's depth limit is real.** `fast-redact` wildcards match a single
level, so `REDACT_PATHS` covers `privateKey` and `wallet.privateKey` but not
`a.b.privateKey`. Nothing leaks today because every call site funnels caught
errors through `describeError`, which extracts only `{message, name}` — but
that is a property of the call sites, not of the redaction config. Do not log a
raw object that may carry a secret at depth ≥ 2. The **receipt store's**
redaction (`src/storage/receipts/redact.ts`) has no such limit: it is a
recursive key-pattern strip at every depth. Both have tests. Resolved `${VAR}` values are never printed, even
in configuration error messages — errors name the *variable*, not the value.

## SSRF

The gateway makes outbound HTTP calls to URLs it was configured with. For v0.1:

- backend URLs are **administrator-controlled configuration only**;
- dynamic, agent- or user-controlled backend URLs are **forbidden** — no code
  path constructs a backend URL from request input beyond `{param}` substitution
  into a configured template, with each value URL-encoded;
- **redirects are not followed** (`redirect: 'manual'`); a 3xx is a
  `BACKEND_ERROR`;
- every call is bounded by an explicit timeout.

Path parameters are additionally checked for dot segments: `.` and `..` are
rejected as `INPUT_INVALID` rather than URL-encoded, because
`encodeURIComponent` does not escape `.` and the WHATWG URL parser then
normalises `..` away — which would let a caller *remove* path segments and reach
a parent endpoint the operator never exposed. After substitution the constructed
path is asserted to still begin with the template's literal prefix.

Caller input can never override a query parameter the operator baked into
`backend.url`. A collision is rejected, not silently applied — otherwise an
input key named after an embedded `?apikey=…` would replace it.

Not implemented in v0.1: an IP/CIDR allowlist or a private-address blocklist. If
you configure `http://169.254.169.254/…`, the gateway will call it. Treat
configuration as privileged.

### Backend response relay

On a non-2xx backend response, the gateway states the **status code** to the
caller (ours to say) but does not forward the backend's **response body**. A
merchant backend in verbose/dev-error mode routinely emits stack traces,
internal hostnames or SQL fragments — a free, often-unauthenticated resource
call is not a safe place to relay that. The body is truncated (512 chars) and
logged at `debug` for the operator only; it never reaches a client-visible
field. A merchant that wants pass-through is a per-resource opt-in, post-alpha.

## Input validation

Validated at the boundary, before anything else happens:

| Input | Check |
|---|---|
| resource input | JSON Schema from the resource definition, closed by default at every level: an object schema — root, nested under `properties`, or nested under `items` — that omits `additionalProperties` gets `additionalProperties: false` stamped on recursively at config load, not just at the root; an operator who sets it explicitly (including explicitly to `true`) is respected at whichever level they set it. A resource that declares no `input:` at all gets an empty closed schema, not an always-valid one — declaring nothing means accepting nothing. Unknown properties, including prototype-named keys (`__proto__`, `constructor`, …), are matched by own-property lookup only. |
| path parameters | URL-encoded on substitution |
| body size | capped at 256 KB, one number for both surfaces, enforced in two different places: Fastify's `bodyLimit` runs inside a body parser on the HTTP routes; `/mcp` deliberately installs a no-op parser so the MCP transport can read the raw stream, so the mount enforces its own byte count instead. A cap that only protects one of two entry points, or two caps that can silently drift apart, is how `/mcp` ended up with no cap at all in the first place. |
| content type | JSON enforced on the invoke routes. **Not** on `/mcp`, where a wildcard no-op parser hands the raw stream to the MCP SDK and the SDK does its own enforcement. |
| payment proof | decoded and schema-validated by the payment provider; a malformed proof is a rejection, never a crash |
| configuration | Zod, strict, before startup |

The reserved `_payment` field is stripped from tool input before schema
validation, so it can never collide with a resource's own properties.

## Payment security

Covered in detail in [payment-flow.md](payment-flow.md). The invariants:

1. Paid resources **fail closed** — thirteen distinct failure conditions, each
   with a test, none of which delivers the resource.
2. `verify` has no fund-moving side effects; only `settle` does.
3. Replay is defended twice: on-chain via EIP-3009 `authorizationState`, and in
   the gateway via a `replayKey` reserved under a `UNIQUE` constraint **before**
   settlement. The key is derived from the authorisation, not the request, so a
   replay against a different request still collides.
4. The gateway holds no buyer or merchant key. The signed authorisation names
   the merchant as recipient, so a broadcaster cannot redirect funds.
5. The effective settlement destination is visible in
   `/.well-known/agent-commerce` and in `doctor`, so misconfiguration is
   noticeable rather than silent.

## Authentication and exposure

The surface splits by audience, and the split is enforced, not advisory:

| Route | Audience | Protection |
|---|---|---|
| `POST /api/resources/:id/invoke` | agents | payment, not authentication |
| `/mcp` | agents | payment, not authentication |
| `GET /api/resources`, `/health`, `/.well-known/agent-commerce` | anyone | none — public by design |
| `GET /ready` | operators | none, but detail is a fixed vocabulary, never raw errors |
| `GET /api/receipts`, `/api/events`, `/api/events/stream` | **operators** | `server.adminToken`, compared in constant time |

The operator routes carry the merchant's commerce ledger. With no
`server.adminToken` configured they return **404**, not open data — a missing
control must not read as an absent restriction.

Browser access uses `server.allowedOrigins`, an explicit allowlist defaulting to
empty. Origin reflection was removed: reflecting the caller's own `Origin` makes
every route cross-origin readable from any page the operator happens to visit,
which is the same thing as having no policy. Agent traffic gets no CORS headers
at all, because it is not browser traffic.

`Origin` and `Host` are validated in one place, the gateway's `onRequest` hook,
so the MCP mount is covered by the same rule as the HTTP routes — including
against DNS rebinding at a hostname resolving to `127.0.0.1`.

Every published port in `docker-compose.yml` binds `127.0.0.1`. Port 8545 in
particular is an Anvil node with unlocked accounts and the full `anvil_*` admin
namespace; on a shared network that would be unauthenticated control of the dev
chain.

## What the gateway relays, and what it does not

The gateway does not forward the merchant backend's own error body to callers.
A backend in verbose or development error mode routinely emits stack traces,
internal hostnames and SQL fragments; relaying them would make the gateway a
pass-through for someone else's internals to whoever called a free resource.
The backend's **status code** is returned — that is ours to state and useful —
and the body is logged server-side at debug level only.

The same rule governs health and readiness detail: a fixed vocabulary on the
wire, raw messages to the log. See
; the rule generalises to any
value crossing a trust boundary.

## Denial of service

Not a focus of v0.1, but more is in place than this section used to list
. What exists:

- request body-size cap, enforced inside the body parsers
- a **1 MB cap on the merchant backend's *response*** — `AbortSignal.timeout`
  bounds a backend call by time, not by bytes
- explicit backend timeouts on every outbound call
- a bounded list limit on every receipts/events query, applied in the store
- a cap on concurrent SSE subscribers
- on `/mcp`: a counting semaphore bounding concurrent tool calls (8) plus a
  bounded queue (64) — over that, `GATEWAY_BUSY` rather than unbounded growth
- readiness memoisation and single-flight, so `/ready` polling cannot amplify
  into one upstream RPC call per request
- `X-Request-Id` accepted only as `[A-Za-z0-9._:-]{1,64}`, so a caller cannot
  write an unbounded string into every audit row

What does **not** exist: rate limiting, per-agent quotas, adaptive
backpressure. Put the gateway behind your own edge if you expose it publicly.

## Dependencies

`x402`, `@modelcontextprotocol/sdk`, `viem`, `fastify` and their transitive
dependencies are third-party code, pinned exactly in
. `npm audit` runs in the release
workflow; high and critical findings are assessed and documented before a
release rather than auto-blocking on irrelevant transitive advisories.

## Development keys

The repository contains Anvil's well-known development accounts, used only on
the local demo chain and labelled `LOCAL DEVELOPMENT ONLY - DO NOT FUND`. They
are public knowledge and anyone can spend from them. Never send real assets to
those addresses, and never reuse them anywhere else.

## Threats we are not addressing in the alpha

Buyer identity and screening · fraud and disputes · refunds and chargebacks ·
multi-tenancy and RBAC · host compromise · supply-chain attestation ·
side-channel and timing analysis · protocol-level censorship or MEV around
settlement · availability guarantees.

An independent security audit has not been performed.
