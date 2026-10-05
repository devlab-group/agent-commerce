"""Mint AP2 v0.2.0 Checkout Mandate vectors with the reference Python SDK.

Run from the AP2 checkout at tag v0.2.0 (commit b4587ac1d055888a73b4b21750973cffba961793)
with the SDK's pinned dependencies installed:

    PYTHONPATH=code/sdk/python python mint.py > vectors.json

Private keys are generated per run and discarded. The output holds public
JWKs, signed tokens and the instant they were minted against.
"""

import base64
import datetime
import hashlib
import json
import sys

from ap2.sdk.disclosure_metadata import DisclosureMetadata
from ap2.sdk.generated.checkout_mandate import CheckoutMandate
from ap2.sdk.generated.open_checkout_mandate import OpenCheckoutMandate
from ap2.sdk.mandate import MandateClient
from ap2.sdk.sdjwt import common
from jwcrypto import jwk, jwt

AP2_COMMIT = 'b4587ac1d055888a73b4b21750973cffba961793'
NOW = int(datetime.datetime(2026, 9, 14, 12, 0, tzinfo=datetime.UTC).timestamp())
MANDATE_AUDIENCE = 'merchant.example'
PROVIDER_ISSUER = 'https://agent-provider.example.com'


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def sha256(text: str) -> str:
    return b64url(hashlib.sha256(text.encode('ascii')).digest())


def public(key: jwk.JWK) -> dict:
    exported = json.loads(key.export_public())
    return {member: exported[member] for member in ('kty', 'crv', 'x', 'y')}


provider = jwk.JWK.generate(kty='EC', crv='P-256', kid='agent-provider-key-1')
merchant = jwk.JWK.generate(kty='EC', crv='P-256', kid='checkout-key-2026-01')
agent = jwk.JWK.generate(kty='EC', crv='P-256', kid='shopping-agent-key-1')

# The merchant checkout JWT in the Agent Commerce profile. AP2 leaves this
# payload to the implementation; `input_hash` is JCS over {"symbol":"ETH"}
checkout = jwt.JWT(
    header={'alg': 'ES256', 'kid': merchant.kid, 'typ': 'JWT'},
    claims={
        'iss': 'https://merchant.example',
        'aud': 'agent-commerce',
        'iat': NOW - 30,
        'exp': NOW + 300,
        'jti': 'checkout_01KSDKVECTOR',
        'agent_commerce': {
            'profile': 'agent-commerce/ap2/checkout/v1',
            'resource_id': 'market_report',
            'input_hash': sha256(json.dumps({'symbol': 'ETH'}, separators=(',', ':'))),
            'amount': '0.01',
            'currency': 'USDC',
            'payment_method': 'x402',
        },
    },
)
checkout.make_signed_token(merchant)
checkout_jwt = checkout.serialize()

closed = CheckoutMandate(
    checkout_jwt=checkout_jwt,
    checkout_hash=sha256(checkout_jwt),
    iat=NOW - 10,
    exp=NOW + 300,
)
client = MandateClient()

# Trusted Agent Provider, exactly as MandateClient.create mints it: no
# top-level iss, aud, iat or exp
closed_mandate = client.create(payloads=[closed], issuer_key=provider)

# The same model under top-level iss, vct and iat, as in the
# agent_authorization.md example, plus aud and exp. Built from the SDK
# helpers MandateClient.create itself uses
claims = common.selectively_disclosable_claims(
    common.delegate_claims_from_model(closed),
    DisclosureMetadata.from_model(closed),
    extra_claims={
        'iss': PROVIDER_ISSUER,
        'vct': 'com.example.agent_mandate',
        'aud': MANDATE_AUDIENCE,
        'iat': NOW - 10,
        'exp': NOW + 300,
    },
)
closed_mandate_with_issuer = common.issue_sd_jwt(
    claims=claims,
    issuer_key=provider,
    header_params=common.header_parameters(provider),
    add_decoy_claims=False,
    serialization_format='compact',
).sd_jwt_issuance

# Autonomous mode: an open mandate, then the agent's closed hop on top of it
open_mandate = client.create(
    payloads=[
        OpenCheckoutMandate(
            constraints=[],
            cnf={'jwk': json.loads(agent.export_public())},
            iat=NOW - 60,
            exp=NOW + 3600,
        )
    ],
    issuer_key=provider,
)
delegated_chain = client.present(
    holder_key=agent,
    mandate_token=open_mandate,
    payloads=[closed],
    aud=MANDATE_AUDIENCE,
    nonce='nonce-sdk-vector',
)

# The SDK's own verifier accepts both closed vectors
for token in (closed_mandate, closed_mandate_with_issuer):
    client.verify(
        token,
        jwk.JWK(**provider.export_public(as_dict=True)),
        payload_type=CheckoutMandate,
        current_time=NOW,
    )

json.dump(
    {
        'ap2Commit': AP2_COMMIT,
        'sdk': {'sd-jwt': '0.10.4', 'jwcrypto': '1.5.6', 'pydantic': '2.12.5'},
        'now': NOW,
        'providerIssuer': PROVIDER_ISSUER,
        'mandateAudience': MANDATE_AUDIENCE,
        'keys': {
            'provider': {'kid': provider.kid, 'jwk': public(provider)},
            'merchant': {'kid': merchant.kid, 'jwk': public(merchant)},
        },
        'checkoutJwt': checkout_jwt,
        'vectors': {
            'closedMandate': closed_mandate,
            'closedMandateWithIssuer': closed_mandate_with_issuer,
            'openMandate': open_mandate,
            'delegatedChain': delegated_chain,
        },
    },
    sys.stdout,
    indent=2,
)
sys.stdout.write('\n')
