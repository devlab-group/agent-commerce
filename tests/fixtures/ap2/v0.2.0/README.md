# AP2 v0.2.0 reference SDK vectors

`vectors.json` holds Checkout Mandates minted by the AP2 reference Python SDK
at tag `v0.2.0`, commit `b4587ac1d055888a73b4b21750973cffba961793`, with
`sd-jwt` 0.10.4, `jwcrypto` 1.5.6 and `pydantic` 2.12.5. `mint.py` produced
them and checks that the SDK's own verifier accepts both closed mandates.
`tests/unit/authorization-ap2/sdk-vectors.test.ts` verifies them here.

| Vector                    | Minted as                                                                                                       | Expected here                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `closedMandate`           | `MandateClient.create`: a Trusted Agent Provider mandate with no top-level `iss`, `aud`, `iat` or `exp`         | accepted                            |
| `closedMandateWithIssuer` | the same mandate content under top-level `iss`, `vct` and `iat`, as in the spec's example, plus `aud` and `exp` | accepted                            |
| `openMandate`             | an open Checkout Mandate, `mandate.checkout.open.1`                                                             | refused, `unsupported_mandate_type` |
| `delegatedChain`          | `MandateClient.present` on the open mandate: a `~~`-joined chain ending in a KB-SD-JWT                          | refused, `unsupported_mandate_type` |

The checkout JWT uses this gateway's checkout profile; AP2 leaves its payload
to the implementation. The tests use the minting time,
`2026-09-14T12:00:00Z`, as their clock.

The file contains public JWKs only. Private keys were generated for the run
and discarded. To regenerate the vectors, check out the AP2 tag, install the
SDK's pinned dependencies, and run:

```bash
PYTHONPATH=code/sdk/python python mint.py > vectors.json
```

Each run creates new keys and signatures. Replace the entire file with the
new output.
