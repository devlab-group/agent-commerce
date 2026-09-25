# AP2 mandate verification

**Experimental.** The gateway can require an AP2 v0.2.0 Direct Checkout
Mandate before a paid resource settles. AP2 is disabled unless configured with
`enabled: true`.

This is merchant-side mandate verification, not a complete AP2 Merchant
implementation. The AP2 provider verifies closed mandates but does not issue
mandates or signed Checkout Receipts.

| Property | Supported value |
| --- | --- |
| Specification | AP2 v0.2.0, tag 2026-04-28, commit `b4587ac` |
| Mode | Direct (Human-Present) |
| Mandate type | closed Checkout Mandate, `vct: mandate.checkout.1` |
| Signature | ES256 with P-256 |
| Trust | static public keys in `config.yaml` |

## What verification establishes

A successful verify-and-reserve call shows that, immediately before its
reservation:

1. a configured mandate issuer signed it with the named configured key;
2. its time claims and audience are valid;
3. it binds a checkout JWT signed by a configured checkout issuer;
4. that checkout JWT matches the resolved resource, validated input, price,
   payment method and settlement coordinates;
5. the mandate identity had no `reserved`, `consumed` or `uncertain` replay
   record, and no other non-released mandate held the checkout JWT `jti`.

The call then reserves the mandate identity and checkout `jti` atomically.

Authorization does not move money or unlock a paid resource by itself. The
request still needs a valid payment proof.

## Pipeline position

```text
CanonicalRequest
  -> resolve resource, validate input, resolve price
  -> no payment proof? return the payment and AP2 requirements
  -> verify payment proof
  -> verify and reserve mandate        AUTHORIZATION_*
  -> reserve payment replay key        PAYMENT_REPLAYED
       reservation failure -> release mandate
  -> settle payment
  -> consume, release or mark the mandate uncertain after settlement
  -> call merchant backend
  -> store receipt with mandate digest
```

Payment verification runs before mandate reservation and must not move funds.
The mandate is reserved before settlement to block concurrent reuse. If
recording the payment attempt fails, the pipeline releases the mandate before
settlement; otherwise the settlement outcome determines its final state.

## Agent Commerce checkout profile

AP2 leaves the checkout payload to the implementation. This gateway requires:

```text
agent-commerce/ap2/checkout/v1
```

The identifier is a namespace, not a URL, and is frozen as a signed wire value.

### Closed Checkout Mandate

The mandate is an SD-JWT presentation with these claims:

| Claim | Required | Rule |
| --- | --- | --- |
| `vct` | yes | exactly `mandate.checkout.1` |
| `iss` | yes | configured mandate issuer |
| `aud` | yes | issuer's configured audience |
| `iat` | yes | no further in the future than allowed clock skew |
| `exp` | yes | checked with allowed clock skew |
| `checkout_hash` | yes | `base64url(SHA-256(compact checkout JWT))` |
| `checkout_jwt` | yes | compact merchant checkout JWT after disclosure resolution |
| `_sd_alg` | when present | `sha-256` |

Presentations with a KB-JWT are refused because this Direct profile does not
verify them. The verifier does not inspect `cnf`.

### Merchant checkout JWT

| Claim | Required | Rule |
| --- | --- | --- |
| `iss` | yes | configured checkout issuer |
| `aud` | yes | issuer's configured audience |
| `iat` | yes | no further in the future than allowed clock skew |
| `exp` | yes | required and checked |
| `jti` | yes | opaque id stored for replay defence and receipt reconciliation |
| `agent_commerce` | yes | profile object below |

### Profile fields

The first six fields are required, non-empty strings. An absent field is a
mismatch.

| Field | Compared with |
| --- | --- |
| `profile` | `agent-commerce/ap2/checkout/v1` |
| `resource_id` | resolved resource id |
| `input_hash` | validated canonical input digest |
| `amount` | resolved decimal price string |
| `currency` | resolved currency |
| `payment_method` | selected payment provider |
| `destination` | payment requirement destination |
| `network` | payment requirement CAIP-2 network |
| `asset` | payment requirement asset |

For `destination`, `network` and `asset`, a value present on either side
must be present and equal on both. x402 requirements name all three. Amounts are
compared as strings, so `0.10` and `0.1` differ.

The mandate is checked against the resolved request; it does not supply values
used to construct the purchase.

### Input hash

```text
input_hash = base64url(SHA-256(RFC 8785 JCS(validated input)))
```

The hash uses RFC 8785 JSON Canonicalization Scheme, including its number
formatting and UTF-16 key ordering. It covers validated canonical input after
`_payment` and `_authorization` are stripped. It excludes request ids and
transport metadata. Backend input bindings may subsequently map that canonical
input into path, query and body values.

## Creating the checkout JWT

The gateway verifies checkout JWTs. The merchant signs them in its own process
with the private half of a key whose public half appears under
`checkoutIssuers`.

```ts
import { createCheckoutJwt } from '@devlab.group/agent-commerce/ap2';

const jwt = await createCheckoutJwt({
  privateKey,
  kid: 'checkout-2026-01',
  issuer: 'https://merchant.example',
  audience: 'agent-commerce',
  resourceId: 'market_report',
  input: { city: 'Berlin' },
  amount: '0.01',
  currency: 'USDC',
  paymentMethod: 'x402',
  destination,
  network,
  asset,
});
```

`createCheckoutJwt` computes the RFC 8785 input digest and rejects missing
required strings, numeric amounts, public or non-P-256 JWKs, and non-PKCS#8 PEM
strings. It cannot compare its inputs with the gateway's eventual payment
requirement. Take price data from the merchant catalogue and settlement
coordinates from the payment challenge.

The buyer's agent or credential provider creates the mandate around this JWT.
This package does not mint mandates.

## Trust

Verification uses operator-configured public keys only:

- `trust.mandateIssuers` and `trust.checkoutIssuers` are separate;
- each issuer has a required, non-defaulted audience;
- `iss` and `kid` must select an exact configured key;
- keys are restricted to public P-256 JWK members;
- the verifier does not fetch JWKS, issuer metadata, `jku` or `x5u`.

### Key rotation

Deploy the new public key beside the old one, switch the signer
to the new `kid`, then remove the old key after old documents expire. Removing
a key from config and restarting is the available revocation mechanism.

## Time checks

`clockSkewSeconds` defaults to 60 and cannot exceed 300. It applies to
`exp`, `nbf` and `iat` on the mandate and checkout JWT. An `iat` beyond
the permitted future skew is refused.

## Replay states

AP2 replay state lives in its own SQLite database at
`authorization.ap2.replay.path`.

The primary replay identity is a digest of the issuer-signed SD-JWT token, not
the full presentation. Different selective-disclosure presentations therefore
collide. The checkout JWT `jti` is also reserved, preventing two mandates
bound to one checkout document from both settling.

| State | Meaning | Reusable? |
| --- | --- | --- |
| `reserved` | settlement outcome not known yet | no |
| `consumed` | settlement succeeded | no |
| `released` | failure proved that no funds moved | only if no other non-released row has the same checkout `jti` |
| `uncertain` | settlement may have been broadcast | no |

No replay rows are swept. Deleting a `reserved`, `consumed` or `uncertain` row
could make a mandate spendable again, so a bounded deployment should archive
only released rows. A crash between settlement and the final replay-state
update leaves the row reserved, favoring a refused retry over a possible second
payment.

## Receipt data

A receipt stores a digest and reconciliation identifiers:

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

The built-in gateway does not persist the presentation, disclosures, checkout
JWT or `Agent-Authorization` header. Its logger redacts the header, and receipt
records contain only the summary above.

The digest identifies an accepted mandate but cannot reconstruct the buyer's
evidence. A merchant that needs dispute-grade evidence must retain it outside
this receipt store.

## Errors

| Code | HTTP | Meaning |
| --- | --- | --- |
| `AUTHORIZATION_REQUIRED` | 403 | after payment verification, required authorization was absent or did not satisfy every required method |
| `AUTHORIZATION_INVALID` | 403 | malformed, untrusted, expired or mismatched proof |
| `AUTHORIZATION_REPLAYED` | 409 | mandate or checkout JWT has a `reserved`, `consumed` or `uncertain` row |
| `AUTHORIZATION_PROVIDER_UNAVAILABLE` | 503 | verifier or replay store did not produce a verdict; retryable |

With no payment proof, the pipeline returns a payment-required response before
checking authorization. After payment verification, missing and invalid
authorization use 403 because another payment cannot repair them. Replay uses
409, and provider unavailability uses 503. Rejection reasons are deliberately
coarse, such as `untrusted_issuer`, `invalid_signature`, `expired` and
`purchase_mismatch`; reporting field-level purchase mismatches would let a
caller read a mandate by elimination.

## Transports

HTTP, MCP and A2A carry this envelope:

```json
{ "method": "ap2", "payload": "<SD-JWT presentation>" }
```

| Surface | Carrier |
| --- | --- |
| HTTP | base64url-encoded JSON in `Agent-Authorization` |
| MCP | reserved `_authorization` tool argument |
| A2A | reserved `_authorization` input field |

The HTTP header is limited to 8192 encoded bytes before decoding. Transport
adapters preserve `payload` byte for byte. Reserved fields are removed before
resource validation, hashing and backend execution.

## Configuration and lifecycle

See [configuration.md](configuration.md#authorizationap2) for the YAML schema
and validation rules. A free resource cannot require AP2 because authorization
gates settlement.

Install the optional AP2 peers with:

```bash
npm install @devlab.group/agent-commerce jose @sd-jwt/core canonicalize
```

`agent-commerce doctor` reports the AP2 pin, trusted issuer ids and key
counts, replay-store status, gated resources and unsupported list.
`GET /.well-known/agent-commerce` reports the descriptor under
`authorizationProviders`.

Whoever creates an AP2 provider must call `close()`. The application
composition root does so after `gateway.close()`; `createGateway()` itself
does not close authorization providers.

## Not implemented

`src/authorization/ap2/descriptor.ts` is authoritative for the unsupported list
published through discovery and `doctor`. The broader implementation limits are:

- autonomous mode and open Checkout Mandates (`mandate.checkout.open.1`)
- intent, cart and Payment Mandate verification
- spending-constraint evaluation
- `cnf`-bound agent keys and delegation chains
- JWKS, issuer metadata, remote key discovery or remote revocation
- key rotation without a config change
- signatures other than ES256 or digests other than SHA-256
- mandate issuance or signed AP2 Checkout Receipts
- an AP2 transport adapter or `/.well-known/ap2`
- AP2 as a payment rail
- AP2 over ACP

Open mandates are refused because their spending constraints are not evaluated.

## Code map

| Path | Responsibility |
| --- | --- |
| `src/authorization/ap2/` | verifier, trust, purchase binding and replay store |
| `src/core/domain/authorization.ts` | generic authorization contract |
| `src/core/execution/pipeline.ts` | verification and reservation ordering |
| `tests/integration/ap2-x402-conformance.test.ts` | end-to-end refusal cases |
| `tests/e2e/authorization/` | on-chain gated settlement |
