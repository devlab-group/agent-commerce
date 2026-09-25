# Security model

[`SECURITY.md`](../SECURITY.md) explains how to report a vulnerability. This
page describes the gateway's trust boundaries, controls, and known limits.

## Trust boundaries

```text
       UNTRUSTED                  GATEWAY PROCESS                       TRUSTED
  ────────────────────       ──────────────────────────       ─────────────────────────

  agent input          ────► validates agent input      ────► merchant backend
  payment proofs             may hold a local                 administrator configured
  authorization proofs       facilitator gas key
  protocol traffic

                             configuration              ◄──── administrator
                             environment                ◄──── operator
```

Agent input is untrusted. Configuration and environment variables are trusted
operator input, so only they may select backend URLs. The gateway never holds
buyer or merchant keys; local payment mode may hold a facilitator key that pays
gas and broadcasts transactions.

## Secret handling

The built-in logger redacts request authorization and payment headers, plus
recognized secret fields such as `privateKey`, `signature`, `secret`,
`challengeSecret`, `apiKey`, `signerPrivateKey`, `adminToken`, and `token`.
Some call sites reduce caught errors with `describeError`; MCP, A2A and ACP log
`CommerceError.toInfo()`, which can include details. Request URLs are logged
without query strings.

Logger field redaction covers the top level and one nested level. It does not
cover a secret at `a.b.privateKey`, so do not log raw nested objects that may
contain credentials. Do not put secrets in `CommerceError` details. Receipt
redaction is recursive, and receipts omit raw payment and authorization proofs.

Environment-substitution errors name the template token and path, never its
resolved value. Later validation errors may echo substituted non-secret values,
such as URLs, so keep secrets in fields designated for credentials.

## Authorization trust (AP2)

AP2 uses operator-configured public keys; it performs no JWKS, issuer metadata,
revocation, `jku`, or `x5u` lookup. Removing a key from configuration and
restarting the process revokes it. See [AP2 trust and rotation](ap2.md#trust).

Local policy fixes verification to ES256 over P-256. The presented `iss` and
`kid` select one configured key, with no fallback to other keys. Replay
identity uses the issuer-signed token, while checkout binding hashes the
compact checkout JWT as presented. Neither value is reconstructed from parsed
JSON before hashing.

## SSRF

The built-in HTTP executor calls only configured backend URLs:

- backend URLs are **administrator-controlled configuration only**;
- request input can replace `{param}` tokens in the configured path or query.
  Tokens in the scheme, host, or port are rejected at config load, and
  substituted values are URL-encoded;
- without `inputBindings`, remaining input becomes query parameters for GET and
  DELETE, or the JSON body for POST, PUT and PATCH. Bindings instead select the
  path, query and body groups;
- **redirects are not followed** (`redirect: 'manual'`); a 3xx is a
  `BACKEND_ERROR`;
- every call has a timeout and a 1 MiB response-body cap.

Empty path values are rejected. Values `.` and `..` are also rejected because
URL parsing would normalize them and could remove configured path segments.
After substitution, the path must still start with the template's literal
prefix. Request input also cannot replace a query parameter already fixed in
`backend.url`; collisions fail as `INPUT_INVALID`.

There is no IP/CIDR allowlist or private-address blocklist. A configured URL
such as `http://169.254.169.254/…` will be called, so configuration is
privileged.

The OpenAPI importer gets backend URLs from the operator's document or
`--base-url`. It rejects relative or unresolved server URLs and makes no
network requests. Review its generated configuration before use.

### Backend response relay

On a non-2xx response, the executor returns the backend status but not its body.
It logs at most 512 body characters at `debug`; default log settings may hide
that detail. This prevents stack traces, internal hosts, and similar backend
details from reaching the client.

## Input validation

| Input | Check |
| --- | --- |
| Resource input | Config-loaded schemas are closed recursively by default; an explicit `additionalProperties` setting is preserved. For a config-loaded resource, a missing `input` accepts only an empty object. A directly constructed resource without an input schema accepts any input. Validation checks own properties; top-level `__proto__`, `_payment` and `_authorization` are removed first. |
| Path parameters | Empty values and dot segments are rejected; other values are URL-encoded. |
| Body size | 256 KiB. Fastify enforces it on parsed routes; raw protocol mounts enforce the same exported limit on the socket. A2A and ACP also cap what their adapters buffer. |
| Content type | HTTP invoke accepts JSON, plain text or an empty body. Raw mounts delegate parsing to their protocol: MCP applies its own rules, ACP requires JSON for a POST body, and A2A does not check content type. |
| Payment proof | The selected provider decodes and validates it. |
| Configuration | Strict Zod shape validation followed by business-rule validation before startup. |

The gateway removes the reserved `_payment` and `_authorization` carriers
before validating resource input.

## Payment security

Covered in detail in [payment-flow.md](payment-flow.md). The invariants:

1. Paid resources fail closed: payment or authorization failures do not deliver
   the resource.
2. `verify` has no fund-moving side effects; only `settle` does.
3. Replay is defended twice: on-chain via EIP-3009 `authorizationState`, and in
   the gateway via a `replayKey` reserved under a `UNIQUE` constraint **before**
   settlement. The key is derived from the authorisation, not the request, so a
   replay against a different request still collides.
4. The gateway holds no buyer or merchant key. A local facilitator key pays gas
   and broadcasts a signed transfer whose recipient the buyer already fixed.
5. The effective settlement destination is visible in
   `/.well-known/agent-commerce` and in `doctor`, so misconfiguration is
   noticeable rather than silent.

## Authentication and exposure

All routes first pass Host validation. Requests with an `Origin` header also
pass the `server.allowedOrigins` check, whose default is empty.

| Route | Audience | Authentication |
| --- | --- | --- |
| `POST /api/resources/:id/invoke` | Agents | None; paid resources require payment. |
| `/mcp` | Agents | None; available when MCP is enabled; paid resources require payment. |
| `GET /api/resources`, `/health`, `/.well-known/agent-commerce` | Public | None. |
| `GET /ready` | Operators | None; it returns fixed status vocabulary rather than raw details. |
| `GET /api/receipts`, `/api/events`, `/api/events/stream` | Operators | `server.adminToken`, compared in constant time. |
| `GET /.well-known/agent-card.json` | Public | None; available when A2A is enabled. |
| `/a2a` | Agents | None; available when A2A is enabled; paid resources require payment. |
| `GET /.well-known/acp.json` | Public | None; it omits private configuration. |
| `/acp/checkout_sessions…` | Agents | `protocols.acp.auth.token`, compared in constant time. |

The operator routes carry the merchant's commerce ledger. With no
`server.adminToken` configured they return **404**, not open data - a missing
control must not read as an absent restriction.

An allowed browser origin receives CORS headers. Requests without `Origin` do
not. The shared `onRequest` hook covers raw mounts such as MCP and uses Host
validation to limit DNS-rebinding attacks.

Every published port in `docker-compose.yml` binds `127.0.0.1`. Port 8545 in
particular is an Anvil node with unlocked accounts and the full `anvil_*` admin
namespace; on a shared network that would be unauthenticated control of the dev
chain.

### ACP

Every ACP checkout route requires `Authorization: Bearer <token>`. The adapter
hashes both values before comparison, so different token lengths do not change
the comparison. Authentication and idempotency-key shape checks run before the
request body is read.

Discovery at `/.well-known/acp.json` is public. It omits the bearer token,
backend URLs, mapped resource ids, and idempotency database path. The token is
not persisted; idempotency keys are scoped by the public base URL, so rotating
the token does not release outstanding claims.

`Signature` and `Timestamp` verification are not implemented or advertised,
and `Signature` cannot replace the bearer token. Use TLS because the bearer
token is otherwise sent in clear text.

Completion `payment_data` passes to the merchant backend as business input. The
built-in gateway does not log it, store it in a receipt, or treat it as an Agent
Commerce payment proof. Delegated payment and delegated authentication are not
implemented.

## Health details

`GET /ready` exposes fixed status terms, not dependency messages. Returned
details are logged at `debug`. Store and provider health throws are logged at
`error`; adapter throws become failed health results whose details are logged
at `debug`. Only `fail` blocks readiness. Results are cached briefly and
concurrent probes share one in-flight check.

## Denial of service

Available bounds include:

- a 256 KiB request cap on parsed routes and raw protocol mounts
- a 1 MiB response cap and timeout in the built-in backend executor
- a bounded list limit on every receipts/events query, applied in the store
- a cap on concurrent SSE subscribers
- on `/mcp`, 8 concurrent tool calls and a queue of 64; excess work gets
  `GATEWAY_BUSY`
- readiness memoisation and single-flight, so `/ready` polling cannot amplify
  into one upstream RPC call per request
- `X-Request-Id` accepted only as `[A-Za-z0-9._:-]{1,64}`, so a caller cannot
  write an unbounded string into every audit row
- an 8192-byte `Agent-Authorization` header cap, checked before decoding;
  MCP and A2A authorization carriers use the request body cap instead

Rate limiting, per-agent quotas, and adaptive backpressure are not implemented.
Add them at the edge for public deployments.

## Dependencies

Runtime dependencies are pinned exactly, and the release workflow runs
`npm audit`. Review the current audit rather than relying on a count recorded in
this document.

`@coinbase/x402` is loaded dynamically only for facilitator `auth.type: cdp`.
It adds `@coinbase/cdp-sdk`, `axios`, and a Solana dependency tree, so audit that
optional installation before using it. Static-token facilitators can use
`auth.type: bearer` without this peer.

## Development keys

The repository contains Anvil's well-known development accounts, used only on
the local demo chain and labelled `LOCAL DEVELOPMENT ONLY - DO NOT FUND`. They
are public knowledge and anyone can spend from them. Never send real assets to
those addresses, and never reuse them anywhere else.

Shared x402 deployment checks reject a well-known Anvil recipient on a
non-local deployment and reject the zero address. Config validation and x402
provider construction both run these checks. The separate well-known Anvil
signer-key check runs only when a local x402 provider is constructed, where it
rejects that key against a non-local RPC.

The MPP provider builds its x402 settlement provider from its own options, so
configured and direct MPP construction both run these checks.

## Mainnet

Base mainnet (`eip155:8453`) requires `allowMainnet: true`, a remote HTTPS
facilitator, a non-development recipient, and canonical USDC address and EIP-712
domain values. A facilitator with `auth.type: none` also requires
`allowUnauthenticatedFacilitator: true`. Shared deployment checks run during
config validation and provider construction; the provider additionally checks
RPC and local-key safety.

A facilitator cannot change an EIP-3009 transfer's signed recipient, amount, or
chain. It can observe authorizations and refuse to broadcast them, which is why
an unauthenticated mainnet facilitator needs a separate acknowledgement.

The in-process facilitator is forbidden on mainnet because it puts a funded gas
key in the gateway process. On Base Sepolia, config accepts any non-empty local
facilitator key. Provider construction requires a 32-byte hex private key and
rejects a well-known Anvil key against a public RPC. The local health check also
requires Anvil, so public Base Sepolia needs remote mode to become ready.

## Adversarial scenarios, and where each is tested

This table maps scenarios to their closest tests. Some unit tests cover only the
named state transition or returned outcome; end-to-end payment tests also check
balances on chain. The two mainnet smoke tests run manually because they move
real funds.

| Scenario                                                             | Outcome                                                           | Where                                             |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------- |
| missing `PAYMENT-SIGNATURE`                                           | 402, no delivery                                                  | `tests/unit/gateway/server.test.ts`               |
| malformed `PAYMENT-SIGNATURE` over HTTP                              | `PAYMENT_INVALID`; no backend call                                | `tests/integration/adversarial-payment.test.ts`   |
| x402 signature, nonce or payer changed after signing                   | rejected before settlement; balances unchanged                   | `tests/e2e/payment/x402-settlement.e2e.test.ts`   |
| network substitution                                                 | `wrong_network` before settlement                                 | `tests/e2e/payment`                               |
| requirement changed to another deployed token, or buyer proof signed for that token | `wrong_asset` or invalid signature before settlement; balances unchanged | `tests/e2e/payment/x402-settlement.e2e.test.ts` |
| proof recipient differs from configured `payTo`                       | `wrong_recipient` before settlement                               | `tests/e2e/payment/x402-settlement.e2e.test.ts`, `tests/unit/payments-x402/provider.test.ts` |
| amount differs from the price in either direction                    | `wrong_amount` before settlement                                  | `tests/e2e/payment/x402-settlement.e2e.test.ts`   |
| replay, sequentially                                                 | refused, no second transfer                                       | `tests/e2e/payment/x402-settlement.e2e.test.ts`, `tests/mainnet/base.smoke.test.ts` |
| **duplicate concurrent request**                                     | settles once, other gets `PAYMENT_REPLAYED`                       | `tests/integration/adversarial-payment.test.ts`   |
| **replay after a gateway restart**                                   | still refused - the reservation is in SQLite                      | same                                              |
| expired authorisation (`validBefore` in the past)                    | refused before settlement                                         | `tests/e2e/payment`                               |
| not-yet-valid authorisation (`validAfter` in the future)             | refused before settlement                                         | `tests/e2e/payment`                               |
| a `{param}` in the host position of `backend.url`                    | refused at config load                                            | `tests/unit/config/schema.test.ts`                |
| an unknown key nested under an `additionalProperties` schema         | rejected by the closed schema                                     | same                                              |
| remote facilitator timeout during settlement                          | provider throws `PAYMENT_PROVIDER_UNAVAILABLE`; pipeline marks the attempt uncertain and returns `PAYMENT_SETTLEMENT_FAILED` | `tests/unit/payments-x402/provider-remote-facilitator.test.ts`, `tests/unit/core/execution/pipeline.test.ts` |
| an unclassified local `settle()` throw                                | provider throws `PAYMENT_PROVIDER_UNAVAILABLE`; pipeline marks the attempt uncertain and returns `PAYMENT_SETTLEMENT_FAILED` | `tests/unit/payments-x402/provider-sdk-mocked.test.ts`, `tests/unit/core/execution/pipeline.test.ts` |
| **remote facilitator 401 / 5xx during verification**                  | transport failure, not a buyer rejection                          | `tests/integration/adversarial-payment.test.ts`   |
| **malformed remote-facilitator response**                            | transport failure; never read as a verdict                        | same                                              |
| **facilitator rejection reason is empty, over 64 characters or outside `[A-Za-z0-9_.-]`** | replaced with `invalid_payment` or `settlement_failed` | `tests/unit/payments-x402/provider-sdk-mocked.test.ts` |
| backend timeout                                                      | `BACKEND_TIMEOUT`                                                 | `tests/unit/core/execution`                       |
| backend 500 after payment                                            | receipt records paid-and-undelivered; payer told it settled       | `tests/unit/gateway`, `tests/unit/core/execution` |
| payment-attempt reservation failure                                  | `STORAGE_ERROR`, never mislabelled `PAYMENT_REPLAYED`             | `tests/unit/core/execution/pipeline.test.ts`      |
| a local reader racing the ledger's creation                          | database is 0600 before SQLite opens it; WAL sidecars stay 0600   | `tests/unit/storage-receipts/permissions.test.ts`, `tests/unit/storage-receipts/persistence.test.ts` |
| RPC unreachable during verify                                        | `PAYMENT_PROVIDER_UNAVAILABLE`, not "bad signature"               | `tests/unit/payments-x402`                        |
| **an external `$ref` in an imported document**                        | refused; zero outbound requests                                   | `tests/unit/openapi/load.test.ts`                 |
| **an imported path value naming another host**                        | percent-encoded into one segment of the configured origin         | `tests/integration/openapi-import.test.ts`        |
| **an imported query group colliding with a pinned backend query**     | `INPUT_INVALID` before payment; nothing settled                   | same                                              |
| **an imported operation with an unsupported required parameter**      | never becomes a resource at all                                   | same                                              |
| **an ACP request with missing, non-bearer, empty or wrong authorisation** | 401 before the body is read; zero merchant calls               | `tests/unit/protocols-acp/adapter.test.ts`        |
| **an ACP request naming an unsupported API version**                  | 400 naming `supported_versions`; never mapped to the pinned one   | same                                              |
| **an ACP POST with no or an over-long `Idempotency-Key`**             | 400; zero merchant calls                                          | `tests/conformance/acp/protocol.test.ts`          |
| **an ACP key replayed while the first request is in flight**          | 409; the merchant is called exactly once                          | `tests/conformance/acp/idempotency.test.ts`       |
| **an ACP operation the merchant acted on before timing out**          | 409 `idempotency_unresolved`; one order, never two                | same                                              |
| **an ACP retry after a merchant 5xx**                                 | the claim is held, not freed; the merchant is not called again    | same, `tests/conformance/acp/errors.test.ts`      |
| **an unresolved ACP record outliving its retention window**           | kept; only a completed record expires                             | `tests/unit/protocols-acp/idempotency.test.ts`    |
| **an ACP claim outliving a bearer-token rotation**                    | kept; the scope is the deployment, never the credential           | same                                              |
| **an ACP key reused with a different body**                           | 422; the merchant is called exactly once                          | same                                              |
| **a merchant answering an ACP route with a non-ACP document**         | refused as `processing_error`; its body never forwarded           | `tests/conformance/acp/errors.test.ts`            |
| **a merchant leaking a connection string or stack in an error body**  | never relayed; the ACP error carries type, code and message only  | same                                              |
| **an ACP `Request-Id` carrying a header-injection payload**           | dropped, never echoed                                             | `tests/unit/protocols-acp/adapter.test.ts`        |
| **an ACP checkout resource configured as paid**                       | refused at config load; a defensive runtime challenge maps to 500 | `tests/unit/config/schema.test.ts`, `tests/unit/protocols-acp/checkout-mapping.test.ts` |
| **an AP2 mandate with a tampered signature**                          | `AUTHORIZATION_INVALID`; nothing settles                          | `tests/integration/ap2-x402-conformance.test.ts`  |
| **an expired AP2 mandate**                                            | `AUTHORIZATION_INVALID`; nothing settles                          | same                                              |
| **a mandate from an issuer that is not configured**                   | refused at the trust allowlist, before any signature check        | same, `tests/unit/authorization-ap2`              |
| **a mandate claiming a trusted `kid` but signed with another key**    | refused at the signature; `kid` selects the key, never labels it  | same                                              |
| **a mandate naming a `kid` the issuer does not have**                 | refused; no "try every key" fallback                              | same                                              |
| **a mandate whose `checkout_hash` does not match its checkout JWT**   | `checkout_binding_failed`; nothing settles                        | same                                              |
| **a mandate approved for another resource, input, amount, currency, payment method, network or asset** | `purchase_mismatch`, one coarse reason; nothing settles | same                                              |
| **a mandate silent about the chain the requirement names**            | refused - fail closed both ways                                   | same                                              |
| **a mandate presented twice**                                         | `AUTHORIZATION_REPLAYED`; the second purchase moves no funds      | same, `tests/e2e/authorization`                   |
| **the same mandate re-presented with a fresh, valid payment proof**   | still refused; balances unchanged on a real chain                 | `tests/e2e/authorization`                         |
| **a mandate replayed under selective disclosure** (one mandate, many presentation strings) | refused - the replay key is the issuer-signed token, not the presentation | `tests/unit/authorization-ap2` |
| **a released mandate re-presented after another mandate reserved or spent the same checkout** | refused as replayed; the released row remains released | `tests/unit/authorization-ap2/replay-store.test.ts` |
| **the AP2 replay store unreachable**                                  | `AUTHORIZATION_PROVIDER_UNAVAILABLE`, retryable, never the buyer's fault | `tests/integration/ap2-runtime.test.ts`     |
| **a payment rejected after a mandate verified**                       | the reservation is released; a corrected proof reuses the mandate | `tests/integration/ap2-x402-conformance.test.ts`  |
| **settlement throws without a verdict, with or without a transaction hash** | the mandate is marked uncertain, not handed back | `tests/integration/ap2-x402-conformance.test.ts`, `tests/unit/core/execution/pipeline-authorization.test.ts` |
| **a free resource configured to require a mandate**                   | refused at config load, and again on the execution path           | `tests/unit/config/ap2.test.ts`, `tests/unit/core/execution` |
| **an oversized `Agent-Authorization` header**                         | `AUTHORIZATION_INVALID`; the pipeline is not called               | `tests/integration/authorization-carrier.test.ts` |
| **an MPP challenge edited after issue, or signed with another gateway's secret** | `challenge_not_issued` | `tests/unit/payments-mpp/provider.test.ts` |
| **an MPP challenge issued for another resource, price, recipient, asset or network** | refused on the binding check, one reason per field | same |
| **an MPP credential presented after its challenge expired** | `challenge_expired`, on the gateway's clock | same |
| **an MPP authorization whose nonce is not the challenge hash** | `wrong_nonce` | same |
| **an MPP credential type other than EIP-3009 `authorization`** | `unsupported_credential` | same |
| **an MPP authorization signed by someone other than the payer, or for another amount or recipient** | `invalid_signature`, `wrong_amount` or `wrong_recipient` | same |
| **an MPP authorization outside its `validAfter`/`validBefore` window** | `authorization_not_yet_valid` or `authorization_expired` | same |
| **a valid MPP credential** | local checks, then the facilitator's read-only check; nothing is broadcast | `tests/unit/payments-mpp/provider.test.ts` |
| **an MPP copy that passes the facilitator check while its replay key is already reserved** | `PAYMENT_REPLAYED`; no second settlement | `tests/unit/payments-mpp/provider.test.ts` |
| **the facilitator is unreachable during MPP verification** | `verify` throws `PAYMENT_PROVIDER_UNAVAILABLE` (503) before anything is reserved | `tests/e2e/payment/mpp-settlement.e2e.test.ts` |
| **an MPP settlement times out after a possible broadcast**            | provider throws `PAYMENT_PROVIDER_UNAVAILABLE`; pipeline records `settlement-uncertain` | `tests/unit/payments-mpp/provider.test.ts`, `tests/unit/core/execution/pipeline.test.ts` |
| **an `Authorization` header in another scheme on an MPP resource** | no payment: `402` with a challenge | `tests/integration/mpp-carriers.test.ts` |
| **an MPP credential in the x402 `PAYMENT-SIGNATURE` header** | ignored: `402` | same |
| **a valid MPP credential from the mppx client** | settled on chain once: buyer down and merchant up by the price, and `Payment-Receipt` names the transaction | `tests/e2e/payment/mpp-settlement.e2e.test.ts` |
| **an MPP broadcast that is never confirmed** | `settlement-uncertain`, no delivery; the recorded transaction lands once mined | `tests/e2e/payment/mpp-settlement.e2e.test.ts` |
| **an MPP buyer with no funds** | facilitator check returns `PAYMENT_INVALID` before broadcast; nothing moved | same |
| **an AP2-gated MPP payment with no mandate, or a mandate approved for x402** | `AUTHORIZATION_REQUIRED` or `AUTHORIZATION_INVALID`; nothing settles | `tests/e2e/authorization/ap2-mpp.e2e.test.ts` |
| **an MPP config on Base mainnet without `allowMainnet`, with a local facilitator, a noncanonical asset or Base Sepolia's EIP-712 name** | `CONFIG_INVALID` at load under the relevant `payments.mpp` field | `tests/unit/config/schema.test.ts` |
| **a valid MPP payment on Base mainnet, then the same credential again** | settled once on chain; the later replay is refused with 402 or 409 and moves no funds again | `tests/mainnet/mpp-base.smoke.test.ts` (real funds, run by hand) |

A facilitator verdict is a returned result. A remote-facilitator transport
throw becomes `PAYMENT_PROVIDER_UNAVAILABLE`. The local x402 provider instead
returns `unexpected_verify_error` for an unclassified verification throw and
`transaction_reverted` for an on-chain settlement revert; other unclassified
settlement throws become `PAYMENT_PROVIDER_UNAVAILABLE`.

Facilitator rejection reasons reach clients and storage only after trimming and
a 64-character, `[A-Za-z0-9_.-]` check. Other values become the fixed token
`invalid_payment` during verification or `settlement_failed` during settlement;
the raw value is available only in debug logs.

## OpenAPI import

The importer reads one local, operator-supplied document and writes ordinary
resource configuration for review. It is not on the request path.

- It rejects sources over 10 MiB and all external `$ref` values. Internal
  references have cycle and depth checks.
- It makes no network requests and does not walk the filesystem.
- OpenAPI security declarations produce a warning and review comment; they do
  not import credentials or turn security headers into caller input.
- Vendor extensions cannot set pricing, payments, backend URLs, or exposure.
- Existing output requires `--force`; failed runs write nothing; successful
  writes use a temporary sibling and rename.
- The importer infers neither pricing nor exposure. `--free` can add free
  pricing and `--expose` can add exposure; paid pricing must be written by hand.
  Imported resources then use the same validation and execution pipeline as
  handwritten resources.

See [OpenAPI import](openapi-import.md) for supported syntax and limitations.

## Threats we are not addressing

Buyer identity and screening · fraud and disputes · refunds and chargebacks ·
multi-tenancy and RBAC · host compromise · supply-chain attestation ·
side-channel and timing analysis · protocol-level censorship or MEV around
settlement · availability guarantees · a malicious facilitator withholding
settlement (it cannot redirect funds, but it can decline to broadcast, and
fail-closed means the resource is simply not delivered).
