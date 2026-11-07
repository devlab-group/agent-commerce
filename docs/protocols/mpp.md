# MPP

**Experimental.** Enable with `payments.mpp.enabled: true`.

The gateway targets `draft-httpauth-payment-01`,
`draft-payment-intent-charge-00`, and `draft-evm-charge-00` at
`tempoxyz/mpp-specs@806fdb8`. It pins the pre-1.0 `mppx@0.13.1` as an
optional peer. For EIP-3009, the gateway follows `mppx`: it hashes
`JSON.stringify([id, realm])` with keccak256 to derive the nonce. The EVM
draft instead hashes `abi.encodePacked(id, realm)`. Credentials using the
draft nonce, including those produced by `mppx` 0.12 or earlier, fail
verification with `wrong_nonce`.

Later drafts or `mppx` releases may change the wire format again, so MPP
remains experimental.

The implemented profile is `charge` intent, `evm` method and EIP-3009
`authorization` credential, using USDC on Base Sepolia or Base. The challenge
is HMAC-bound to the resource and terms. It includes the canonical Permit2
address in `methodDetails.permit2Address`, as `draft-evm-charge-00` requires
for every credential type. The credential is verified locally,
then checked by the x402 settlement provider. Both checks run in `verify`,
before replay reservation; settlement broadcasts later.

For an HTTP request with a body, the challenge includes an RFC 9530
`sha-256` digest of the original body bytes. During credential verification,
the paid request must send the same bytes: equivalent JSON with different
spacing returns `body_digest_mismatch`. MCP and A2A challenges omit the digest
because their payment proof travels in the request body.

MPP and x402 derive the same replay identity for the same EIP-3009
authorization, so reuse across rails collides in one receipt store.

`payments.mpp.paymentFlow` takes the [x402 flow values](x402.md), but defaults to
`upfront`: the payment settles before the backend runs. The `charge` intent
forbids partial access before payment verification, which for the EVM method
includes the transfer, and counts a backend call as partial access. Choosing
`authorization` departs from that rule: the backend runs first, and a refused
or unconfirmed settlement withholds its response but leaves its work unpaid.
Under `authorization`, backend time also counts toward the challenge lifetime,
`challengeTtlSeconds` (default 300), because `mppx` signs `validBefore` equal
to the challenge's `expires`.

Over HTTP, the unpaid 402 and MPP verification, replay, settlement, and
provider errors use `application/problem+json` and the core draft's problem
types; the unpaid one is `payment-required`. Envelope members such as `code`,
`message`, and `details` stay as extension members, and `status` is the numeric
HTTP status. `detail` is a sentence; the reason token stays in `message` and
`details.reason`. A successful `Payment-Receipt` includes `challengeId` and
`chainId`.

A credential whose challenge already paid for a request is `invalid-challenge`
with reason `challenge_already_used`. The gateway learns this from the
facilitator's reason or the token's `authorizationState`. When neither shows
it, including when that read fails, the facilitator's reason is reported
instead, under `verification-failed`.

Terminate TLS in front of deployed MPP endpoints. The core draft forbids
issuing challenges over plain HTTP.

Base mainnet deployments must satisfy the
[mainnet guardrails](../configuration.md#mainnet-guardrails).

Unsupported variants are listed in `src/payments/mpp/descriptor.ts`: non-EVM
methods, Permit2/transaction/hash credentials, splits, subscriptions, EVM
sessions and the discovery extension.

## Idempotency-Key

Experimental and disabled by default. On a resource with
[`idempotency.redelivery`](../configuration.md#resources), the HTTP invoke
route reads the buyer's `Idempotency-Key` header. Quoted values follow RFC 9651
String syntax: `"abc"` and `abc` are the same key, and `\"` and `\\` are
unescaped. Bare keys, as sent by ACP clients, are also accepted. The decoded
key must contain 1 to 255 printable ASCII characters, as in ACP; invalid keys
return HTTP 400 `bad-request` with reason `payment_identifier_invalid`.

After delivery, reuse the key and input to retrieve the stored response without
another charge. An exact resend of `Authorization` skips verification, so an
expired challenge still works while the response is retained. A new credential
must answer a fresh challenge and verify as the same payer; it is not settled
again. Invalid credentials get the usual 402 without revealing whether the key
exists.

Make the key random and keep it secret: with the original credential, it
unlocks the stored response. The gateway's logger redacts the header; keep it
out of proxy, APM and access logs too. The MCP and A2A adapters do not extract
this header, and `redelivery.required` does not apply to MPP.

Conflict, in-flight and unresolved refusals use Problem Details with
`type: about:blank` and the HTTP status phrase as `title`. An `invalid-challenge`
response could prompt another payment. Reusing a key with other input or
another payer returns 422 `Unprocessable Content`, following section 2.7 of
`draft-ietf-httpapi-idempotency-key-header-08`. A client may interpret 409 as
"retry unchanged" and keep retrying a request that cannot succeed. x402 uses
409 for this case. `details.reason` identifies the state:

- `payment_identifier_conflict` (422): the key belongs to different input or another payer.
- `payment_identifier_in_flight` (409 `Conflict`, with `Retry-After`): a request with the key is still running.
- `payment_identifier_unresolved` (409 `Conflict`): the earlier request may have been charged but has no
  usable stored response.

[http.md](http.md) lists the redelivery headers.
