# ACP

**Experimental.** Enable with `protocols.acp.enabled: true`.

| Property                            | Value                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------ |
| Binding                             | REST over HTTP(S)                                                        |
| Snapshot and accepted `API-Version` | `2026-04-17` only                                                        |
| Vendored schema                     | `src/protocols/acp/spec/2026-04-17/`                                     |
| Discovery                           | `GET /.well-known/acp.json`                                              |
| Default mount                       | `/acp`                                                                   |
| Service                             | `checkout` only                                                          |
| Authentication                      | bearer token on every checkout route                                     |
| Idempotency                         | durable key on every POST, completed rows retained for at least 24 hours |

The schema is vendored and never fetched. Runtime code imports only the dated
snapshot; it reads nothing from `spec/unreleased`. The adapter validates its
discovery document at startup and fails with `CONFIG_INVALID` if it does not
match. A version upgrade adds a new snapshot rather than editing this one.

## Required headers

| Header            | Scope                | Rule                                                                                                                                       |
| ----------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Authorization`   | every checkout route | `Bearer <token>`, constant-time comparison; a refusal is 401 with `WWW-Authenticate: Bearer`                                               |
| `API-Version`     | every checkout route | exactly `2026-04-17`; missing and unsupported are distinct errors                                                                          |
| `Content-Type`    | every POST           | if present, `application/json` or any media type ending in `+json`; an empty body may omit it, but a supplied non-JSON type still gets 415 |
| `Idempotency-Key` | every POST           | 1-255 printable ASCII characters                                                                                                           |
| `Request-Id`      | optional             | bounded and filtered; echoed on every checkout response, refusals included; separate from the gateway request id                           |

An absent, older, newer or malformed API version is not mapped to the supported
snapshot.

## Headers sent to the merchant

The gateway forwards `Accept-Language`, `User-Agent`, `Request-Id`,
`API-Version`, `Signature` and `Timestamp` to the merchant when present,
printable ASCII and at most 2048 characters long. It never forwards the
agent's `Authorization`, the caller's `Idempotency-Key`, which the derived key
replaces, or any other caller header. A `backend.headers` entry of the same name
wins, so an operator who wants a fixed `User-Agent` at the merchant must
configure one.

`Signature` and `Timestamp` pass through unverified. The gateway re-serializes
the JSON body, so a merchant that verifies the raw request bytes fails; only one
that verifies a canonical form of the parsed JSON can succeed. No signing agent
has been tested against this path.

## Checkout operations

| Operation                 | Route                                          | Success | Canonical input                     |
| ------------------------- | ---------------------------------------------- | ------- | ----------------------------------- |
| `createCheckoutSession`   | `POST {mount}/checkout_sessions`               | `201`   | `{ body }`                          |
| `updateCheckoutSession`   | `POST {mount}/checkout_sessions/{id}`          | `200`   | `{ path, body }`                    |
| `getCheckoutSession`      | `GET {mount}/checkout_sessions/{id}`           | `200`   | `{ path }`                          |
| `completeCheckoutSession` | `POST {mount}/checkout_sessions/{id}/complete` | `200`   | `{ path, body }`                    |
| `cancelCheckoutSession`   | `POST {mount}/checkout_sessions/{id}/cancel`   | `200`   | `{ path }`, plus `body` if supplied |

Each operation maps to a resource in `protocols.acp.checkout.operations`.
All five mappings are required, and each operation must use a different resource.
Each resource must include `expose: [acp]`, be free at the Agent Commerce invocation
layer and have an empty payments list.

Request bodies are validated against the pinned schema before pipeline
execution; an invalid request returns `400 invalid_request_body`. Successful
merchant responses are validated before return. An invalid merchant document or
success status outside the ACP contract becomes a safe `processing_error`; the
merchant body is not relayed or cached.

Validation accepts unknown values in the `supported` and `required` lists of
`capabilities.interventions`, in both directions, and passes them through,
because the capability negotiation RFC (4.6.2) says to ignore unknown
capability values. It also accepts an unknown value of an enum whose schema
description calls it extensible. Unknown fields, and unknown values of every
other enum, are still refused.

Completion accepts the schema's two outcomes: a completed session with an
order, or an ordinary non-completed session without one.

See [examples/acp-checkout](../../examples/acp-checkout).

## ACP payment boundary

ACP `payment_data` belongs to the merchant checkout flow. It remains ordinary
backend input and is not converted into an Agent Commerce `_payment`, x402 or
MPP proof.

Config rejects paid checkout resources. If the pipeline nevertheless returns a
payment challenge, the adapter logs the broken deployment and returns a safe
500 because ACP has no Agent Commerce challenge representation.

The ACP adapter contains no payment logic and never calls a merchant backend
directly; it sends one canonical request through the pipeline. Its bearer token
is used only for constant-time request authentication and is not written to the
idempotency database, logs or responses.

## Idempotency

The adapter validates `Idempotency-Key` before reading a POST body. After body
parsing, it claims the key before calling the merchant. The scope is
`(deployment public base URL, concrete endpoint path, caller key)`; bearer
credentials are not part of it. Two clients using the same caller key on the
same endpoint therefore share one claim.

The body fingerprint uses parsed JSON. Object key order and numeric spelling
such as `1` versus `1.0` normalize; array order, type, and null versus absence
remain distinct.

| Situation                                                                   | Response                                                                                                       |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| first request                                                               | atomically claimed before merchant execution                                                                   |
| same key and body, still running                                            | `409 idempotency_in_flight` with `Retry-After`                                                                 |
| same key and body, completed                                                | stored response with `Idempotent-Replayed: true`; no merchant call                                             |
| same key, different body                                                    | `422 idempotency_conflict`; no merchant call                                                                   |
| ACP response below 500 after the claim, including pipeline `INPUT_INVALID`  | cached                                                                                                         |
| ACP response 500 or higher after the merchant may have run                  | `409 idempotency_unresolved` on retry by default; with `merchantIdempotent`, the claim is released for a retry |
| ACP response 500 or higher when the merchant was not called or answered 429 | claim released; a clean retry may run                                                                          |

The ACP response status controls claim finalization. The gateway treats a
merchant 429 as unprocessed, releases the claim and returns ACP 503. Merchants
must send 429 before side effects. A merchant 503 also maps to ACP 503 but may
follow partial work, so its claim stays unresolved unless
`merchantIdempotent` is set. Merchant 401 and 403 map to ACP 502 and stay
unresolved. A post-claim pipeline `INPUT_INVALID` maps to ACP 400 and is cached.

Request guards run before the claim, so their failures are never stored. These
include routing, authentication, header, body, JSON, schema and content-type
errors. The response echoes a filtered `Request-Id`; a POST also echoes a
well-formed `Idempotency-Key`, even when a guard fails before checking it. A
malformed key is never echoed, and routing 405 includes `Allow`.

ACP requires a fresh attempt after a 5xx. By default, the gateway keeps the
claim when the merchant may have acted, to avoid a duplicate order. Set
`protocols.acp.idempotency.merchantIdempotent: true` only if the merchant
deduplicates by the derived key. The gateway then releases the claim after a
5xx and frees claims left in flight when it next starts.

An in-flight row becomes completed, released or unresolved when the request
finishes. A crash or a SQLite error while finalizing can leave it in-flight;
the next gateway start marks it unresolved by default or frees it when
`merchantIdempotent` is enabled. Startup logs the count. This assumes one
gateway process per idempotency database file.

Only completed records expire, after at least 24 hours. Unresolved records
remain for operator reconciliation. This avoids rerunning an unknown remote
side effect but is not an exactly-once transaction across HTTP and SQLite.
Expired completed rows are purged lazily when a later request claims a key;
there is no background sweep.

The schema-v1-to-v2 migration rebuilds the idempotency table empty because its
bearer-token-scoped keys cannot be translated. If it drops non-completed rows,
startup logs a warning that tells the operator to reconcile them with the
merchant before trusting a retry.

For side-effecting ACP operations, the gateway sends the merchant a derived
`Idempotency-Key`: SHA-256 over deployment, endpoint and caller key. It is
stable across retries, restarts and bearer-token rotation; differs across
endpoints and deployments; and reveals no caller key. A static
`Idempotency-Key` in backend headers is replaced by this derived value.

The merchant should store and replay results under the derived key. In the
default mode, the gateway holds uncertain claims to block duplicate checkout
calls. With `merchantIdempotent` enabled, the merchant must prevent duplicates
on retry. A proxy retry outside the gateway can also repeat a side effect if
the merchant does not deduplicate.

## ACP errors

| Cause                                                     | Response                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| pipeline `INPUT_INVALID`                                  | `400 invalid_request_body`                                     |
| merchant 404                                              | `404 checkout_session_not_found`                               |
| merchant 405 on cancel                                    | `405 checkout_session_not_cancelable`                          |
| merchant 405 on another operation                         | `405 method_not_allowed`                                       |
| merchant 400 or 422                                       | the same status, `invalid_request_body`                        |
| valid merchant ACP error on a relayed status              | that status, with its `type`, safe `code` and optional `param` |
| merchant 409                                              | `409 checkout_session_conflict`                                |
| merchant 429 or 503                                       | `503 service_unavailable` with `Retry-After`                   |
| merchant 401, 403, another 5xx or another unmapped status | `502 processing_error`                                         |
| backend timeout                                           | `504 service_unavailable`                                      |
| load shedding                                             | `503 service_unavailable`                                      |
| mapping, storage or unexpected payment challenge          | `500 processing_error`                                         |

ACP errors contain `type`, `code`, `message`, a safe `param` when available,
and `supported_versions` for API-version errors. For a valid merchant ACP error
on a relayed status, the gateway uses its `type` and a snake_case `code` of at
most 64 characters. A code starting with `idempotency_` is not relayed,
because only the gateway issues those codes. It also includes a bounded,
printable `param` when present. The gateway supplies its own `message`; no
other merchant body fields are sent to the agent. Merchant 401/403 is not
presented as a failure of the agent's ACP bearer token.

`Retry-After` on a 503 for a merchant 429 or 503 is the merchant's value when
it is whole seconds, clamped to 1-300, and 5 otherwise.

Session ids such as `gid://shop/Checkout/1` are accepted when encoded as one
URL segment. Empty ids and ASCII control characters are refused. Merchant
markdown containing an HTML tag or comment is refused as `processing_error`
before it reaches the agent.

## ACP discovery

```json
{
  "protocol": {
    "name": "acp",
    "version": "2026-04-17",
    "supported_versions": ["2026-04-17"]
  },
  "api_base_url": "https://merchant.example.com/acp",
  "transports": ["rest"],
  "capabilities": { "services": ["checkout"] }
}
```

Discovery is public while ACP is enabled and uses
`Cache-Control: public, max-age=3600`. Optional documentation, currency,
locale and intervention metadata appears only when configured. Tokens, backend
URLs, resource ids and database paths are excluded.

## ACP exclusions

The adapter excludes carts, feed and standalone orders; delegated payment and
authentication; the ACP MCP binding; webhooks and outbound delivery; the client
role; `Signature` and `Timestamp` verification; discounts and the general
extension framework; seller-backed payment handlers; and other ACP versions.
A `Signature` header does not replace bearer authentication.

No ACP SDK ships. Conformance tests use the vendored official schema and examples.
