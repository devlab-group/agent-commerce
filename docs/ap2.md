# AP2 mandate verification

**Experimental.** The gateway verifies an [AP2](https://github.com/google-agentic-commerce/AP2)
**v0.2.0 Direct Checkout Mandate** before it lets a payment settle, so a paid
resource can require proof that the human behind an agent approved *this exact
purchase*.

Off by default: a deployment that configures nothing here behaves exactly as it
did before AP2 existed.

## Call it what it is

This is **AP2 merchant-side mandate verification**, not a full AP2 Merchant
implementation. AP2 v0.2's Merchant role also covers Checkout Receipts, and the
gateway holds no signing key and issues none. It is the verifying half.

| | |
| --- | --- |
| Spec | AP2 **v0.2.0**, tagged 2026-04-28, commit `b4587ac` |
| Mode | Direct (Human-Present) |
| Mandate type | closed Checkout Mandate, `vct` exactly `mandate.checkout.1` |
| Signatures | ES256 over P-256, and nothing else |
| Trust | static public keys in `config.yaml`, no discovery of any kind |

## What a verified mandate proves

1. A configured issuer signed it, with a key that issuer declared.
2. It has not expired, and was not issued in the future.
3. It is addressed to this merchant.
4. It binds a checkout document the merchant signed.
5. That document authorises the resource, input, price and rail in front of us.
6. It has not been spent before.

Nothing else. A mandate never unlocks a resource on its own and never moves
money: a gated resource still needs a real payment proof.

## Where it sits

```text
CanonicalRequest
  -> resolve resource, validate input, resolve price
  -> no payment proof?  402 challenge + the AP2 requirement
  -> verify payment proof            no funds move
  -> VERIFY AND RESERVE THE MANDATE  AUTHORIZATION_*, fail closed
  -> reserve the payment replay key
  -> settle                          funds move here, and only here
  -> consume | release | mark uncertain the reservation
  -> merchant backend
  -> receipt, carrying the mandate's digest
```

The order is the control. Payment verification runs first because it has no
side effect, so a bad proof cannot burn a reservation; the mandate is reserved
before settlement, so two presentations cannot race one payment; and its fate
is decided afterwards, because until settlement returns nobody knows it.

## The Agent Commerce checkout profile

AP2 leaves the checkout payload outside its scope, so the claims a paid
invocation needs are specified here instead, under the identifier

```text
agent-commerce/ap2/checkout/v1
```

A bare name, like the gateway's other wire identifiers: a profile id is a
namespace, never dereferenced, so a URL would only tie the format to a domain.
**Frozen** once released, because merchants sign it into every checkout JWT.

### The mandate

A closed Checkout Mandate, presented as an SD-JWT with its disclosures:

| Claim | Required | Notes |
| --- | --- | --- |
| `vct` | yes | exactly `mandate.checkout.1` |
| `iss` | yes | must be a configured mandate issuer |
| `aud` | yes | must equal that issuer's configured `audience` |
| `iat` | yes | rejected if further ahead than the configured skew |
| `exp` | yes | required, not only checked when present |
| `checkout_hash` | yes | `base64url(SHA-256(compact checkout JWT))` |
| `checkout_jwt` | yes | the compact merchant checkout JWT, read after disclosures resolve |
| `_sd_alg` | when present | `sha-256` only |

A key-bound presentation (`cnf`, a KB-JWT) is refused: Direct mode issues none,
so one arriving belongs to a flow this release does not verify.

### The merchant checkout JWT

| Claim | Required | Notes |
| --- | --- | --- |
| `iss` | yes | must be a configured **checkout** issuer |
| `aud` | yes | must equal that issuer's configured `audience` |
| `iat` | yes | rejected if further ahead than the configured skew |
| `exp` | yes | required |
| `jti` | yes | an opaque id; recorded in the receipt and used for replay defence |
| `agent_commerce` | yes | the profile object below |

### The profile object

Every field is a string, and absent is a mismatch rather than a skipped check:
a mandate that will not say which resource or how much authorises nothing in
particular.

| Field | Compared against |
| --- | --- |
| `profile` | the literal `agent-commerce/ap2/checkout/v1` |
| `resource_id` | the resolved resource |
| `input_hash` | the digest of the validated input, below |
| `amount` | the resolved price, **as a string** |
| `currency` | the resolved currency |
| `payment_method` | the payment provider that built the requirement |
| `destination` | the requirement's settlement destination |
| `network` | the requirement's CAIP-2 network |
| `asset` | the requirement's asset |

The last three are checked whenever **either** side names one, so under x402,
which names all three, all three are required. A mandate silent about the chain
must not unlock a settlement on one, and a mandate naming a chain the
requirement lacks was approved for another rail.

Amounts are compared as decimal strings, never numerically: `0.10` and `0.1`
are different strings, and a mandate says what it says.

Everything is compared against the **already resolved** request. Nothing is
taken from the mandate and used to shape the purchase, which would invert the
control.

### The input hash

```text
input_hash = base64url(SHA-256(RFC 8785 JCS(validated input)))
```

[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) (JCS), not a sorted-key
`JSON.stringify`. The merchant's signer computes this digest too, probably in
another language, and the two agree only if both follow JCS number formatting
and UTF-16 key ordering.

What gets hashed is exactly what the backend will receive: validated, reserved
fields stripped, no request id, no transport metadata. A buyer could not have
known any of that when they approved.

Without it, one mandate for `translate` would authorise any translation.

## Trust

**Static public keys only.** Every verification key is written into
`config.yaml` by an operator.

- No JWKS, no issuer metadata, no fetching of any kind at runtime.
- `jku` and `x5u` are not followed. A JWK carrying either is refused at load,
  by an allowlist of members (`kty`, `crv`, `x`, `y`, `kid`, `alg`, `use`)
  rather than a denylist that has to remember them.
- Private material (`d`) is refused at load, naming the key to rotate.

A mandate's `iss` and `kid` only choose *which* configured key verifies it. An
unrecognised pair is refused, so a mandate can never nominate its own signer,
and there is no "try every key" fallback that would make `kid` advisory.

**Two separate lists.** `trust.mandateIssuers` signs mandates;
`trust.checkoutIssuers` signs the merchant's checkout documents. Being trusted
for one confers nothing for the other.

Each issuer carries its own `audience`, required and never defaulted. Without
it a mandate minted for another merchant would verify here, and there is no
value worth guessing for something that decides that.

### Rotating a key

List the new public key beside the old one under the same issuer and deploy;
move the signer to the new `kid`; once nothing old is in flight, remove the old
key and deploy again. Both are live during the overlap, and `kid` picks which
one verifies a given mandate.

There is no revocation API: removing a key from the config and restarting is
the revocation.

## Time

`clockSkewSeconds` (default 60, ceiling 300) applies to `exp`, `nbf` and `iat`
on both the mandate and the checkout JWT. The ceiling exists because a skew
wide enough to cover a mandate's whole validity window stops `exp` rejecting
anything; an operator needing more than five minutes has a clock to fix.

`iat` further ahead than the skew is refused. That is a broken signer, or a
mandate minted to outlive its own expiry window.

## Replay

A mandate is spendable exactly once, recorded in its own SQLite database
(`authorization.ap2.replay.path`) that no other store shares.

The replay key is a digest of the **issuer-signed token**, not of the
presentation. Selective disclosure gives one mandate many valid presentation
strings, so keying on the presentation would let it be spent once per disclosed
subset. The checkout `jti` is guarded as well, so two mandates binding one
checkout document cannot both settle.

| State | Meaning |
| --- | --- |
| `reserved` | claimed, outcome not yet known. Not reusable |
| `consumed` | settled. Never reusable |
| `released` | nothing happened. Presentable again |
| `uncertain` | settlement broadcast, outcome never learned. Not reusable |

Only a failure that provably moved no money releases a reservation. A
settlement broadcast but never confirmed is marked `uncertain` instead: the
buyer's funds may already have moved, and a mandate handed back after that can
be spent twice.

Nothing is swept: deleting a consumed row makes that mandate spendable again,
and it must stay consumed for as long as the merchant can be asked what they
delivered. If the table needs bounding, archive `released` rows only.

Settlement and the local commit are not one transaction. If the process dies
between them the row stays `reserved` and that mandate is refused from then on:
a refused retry costs a round trip, the other direction costs a second payment.

## What is recorded, and what is not

A receipt keeps a method and a digest:

```json
{
  "authorization": {
    "method": "ap2",
    "reference": "sha256:BASE64URL",
    "metadata": {
      "mandateIssuer": "https://surface.example",
      "checkoutIssuer": "https://merchant.example",
      "checkoutId": "checkout_01K..."
    }
  }
}
```

The presentation, its disclosures, the checkout JWT and the
`Agent-Authorization` header are **never** stored and never logged. A receipt
outlives the request that produced it, and a stored mandate would be a
spendable secret at rest. Failures are logged as reason codes.

**Evidence retention is not solved here.** A digest proves a mandate with that
identity was accepted; it does not reconstruct what the buyer saw or agreed to.
Dispute-grade evidence stays with the merchant or the system that minted the
mandate, unless an encrypted evidence store is added later.

## Errors

| Code | HTTP | When |
| --- | --- | --- |
| `AUTHORIZATION_REQUIRED` | 403 | the resource requires a mandate and none was presented |
| `AUTHORIZATION_INVALID` | 403 | signature, trust, binding, time or purchase mismatch |
| `AUTHORIZATION_REPLAYED` | 409 | the mandate is good, and already spent |
| `AUTHORIZATION_PROVIDER_UNAVAILABLE` | 503 | our verifier or store failed. Retryable |

403 rather than 402: the buyer's money is not the problem. A 402 tells a client
"pay and retry", which cannot fix a rejected mandate, and a client that auto-pays
on 402 would be charged for a request that was never going to be delivered.

Rejection reasons are coarse by design (`untrusted_issuer`, `invalid_signature`,
`expired`, `purchase_mismatch`, and a handful more). A caller learns roughly
where its mandate was refused, not which field disagreed: finer detail lets
someone read a mandate's contents out of the gateway by elimination.

An outage is never recorded against the payer. Their mandate may be perfectly
good.

## Carrying a mandate

One envelope, three transports:

```json
{ "method": "ap2", "payload": "<the SD-JWT presentation>" }
```

| Surface | Carrier |
| --- | --- |
| HTTP | `Agent-Authorization` header, base64url of that JSON |
| MCP | the reserved `_authorization` tool argument |
| A2A | the reserved `_authorization` input field |

HTTP uses a header because the payment proof already travels out of band there,
and an authorization inside the body would have to survive every backend
input-binding mode intact. The header is capped at 8192 bytes, checked before
any decode; see [security.md](security.md#denial-of-service).

The payload is preserved byte for byte from the wire. Reserved fields are
stripped before validation, so `_authorization` never reaches the merchant
backend and never enters the input hash.

## Configuration

The YAML block and every rule the loader enforces are in
[configuration.md](configuration.md#authorizationap2). One rule surprises
people: `required: [ap2]` on a **free** resource is refused, at load and again
on the execution path. Authorization gates settlement, so where there is no
settlement nothing would ever read the mandate.

The provider lives on the `./ap2` subpath and its peers are optional:

```bash
npm install @devlab.group/agent-commerce jose @sd-jwt/core canonicalize
```

`agent-commerce doctor` reports the pins, the trusted issuer ids with key
counts, the replay store's writability, and which resources a mandate gates.

## Not implemented

Refused rather than half-served. The adapter descriptor and `agent-commerce
doctor` print the machine-readable half of this at runtime; this page adds the
AP2 roles and artefacts the gateway does not play or produce. If the two ever
disagree about something they both name, the runtime list is the truth and this
page is a bug.

- autonomous mode, and open Checkout Mandates (`mandate.checkout.open.1`)
- intent mandates, cart mandates, Payment Mandate verification
- spending-constraint evaluation (`allowed_merchants`, `line_items`)
- `cnf`-bound agent keys and delegation chains
- JWKS, `jku`, `x5u`, issuer metadata fetching, remote revocation
- key rotation without a config change
- algorithms other than ES256, digests other than sha-256
- mandate issuance, merchant checkout JWT issuance, signed Checkout Receipts
- an AP2 transport adapter, `/.well-known/ap2`, AP2 as a payment rail
- AP2 over the ACP checkout adapter

Open mandates are the one worth naming twice: they carry spending constraints
this release does not evaluate, so accepting one would tell a buyer their
limits were checked when nothing read them.

## Where to look

| | |
| --- | --- |
| `src/authorization/ap2/` | verifier, trust store, purchase binding, replay store |
| `src/core/domain/authorization.ts` | the generic contract core enforces |
| `src/core/execution/pipeline.ts` | the ordering above |
| `tests/integration/ap2-x402-conformance.test.ts` | every refusal, end to end |
| `tests/e2e/authorization/` | a gated purchase settling on a real chain |
