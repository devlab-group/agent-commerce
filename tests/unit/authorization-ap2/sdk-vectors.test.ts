/**
 * Mandates minted by the AP2 reference SDK at v0.2.0, not by this repository.
 * tests/fixtures/ap2/v0.2.0/README.md records how they were made.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Ap2TrustedKey, EnabledAp2Config } from '../../../src/authorization/ap2/types';
import { createAp2MandateVerifier } from '../../../src/authorization/ap2/verifier';
import { type CommerceError, isCommerceError } from '../../../src/core';
import { fixedClock } from './fixtures';

interface SdkVectors {
  readonly now: number;
  readonly providerIssuer: string;
  readonly mandateAudience: string;
  readonly keys: { readonly provider: Ap2TrustedKey; readonly merchant: Ap2TrustedKey };
  readonly vectors: {
    readonly closedMandate: string;
    readonly closedMandateWithIssuer: string;
    readonly openMandate: string;
    readonly delegatedChain: string;
  };
}

const sdk = JSON.parse(
  readFileSync('tests/fixtures/ap2/v0.2.0/vectors.json', 'utf8'),
) as SdkVectors;
const MINTED_AT = new Date(sdk.now * 1000);

function verifierFor(overrides: Partial<EnabledAp2Config> = {}, at: Date = MINTED_AT) {
  return createAp2MandateVerifier({
    config: {
      enabled: true,
      specVersion: '0.2.0',
      mode: 'direct',
      trust: {
        mandateIssuers: [
          { issuer: sdk.providerIssuer, audience: sdk.mandateAudience, keys: [sdk.keys.provider] },
        ],
        // The checkout JWT mint.py signed in the Agent Commerce profile
        checkoutIssuers: [
          {
            issuer: 'https://merchant.example',
            audience: 'agent-commerce',
            keys: [sdk.keys.merchant],
          },
        ],
      },
      clockSkewSeconds: 60,
      replay: { path: ':memory:' },
      ...overrides,
    },
    clock: fixedClock(at),
  });
}

async function refusal(run: Promise<unknown>): Promise<CommerceError> {
  try {
    await run;
  } catch (error) {
    expect(isCommerceError(error)).toBe(true);
    return error as CommerceError;
  }
  return expect.unreachable('expected the mandate to be refused') as never;
}

describe('mandates minted by the AP2 reference SDK', () => {
  it('accepts a Trusted Agent Provider mandate exactly as MandateClient.create mints it', async () => {
    // No top-level `iss`, `aud`, `iat` or `exp`: the kid selects the issuer
    const result = await verifierFor().verify(sdk.vectors.closedMandate);
    expect(result.mandateIssuer).toBe(sdk.providerIssuer);
    expect(result.checkoutJwtId).toBe('checkout_01KSDKVECTOR');
  });

  it('accepts the same mandate content under top-level iss, aud, iat and exp', async () => {
    const strict = verifierFor({ requireMandateAudience: true, requireMandateExpiry: true });
    await expect(strict.verify(sdk.vectors.closedMandateWithIssuer)).resolves.toBeDefined();
  });

  it('meets a required expiry from the exp inside the mandate content', async () => {
    const strict = verifierFor({ requireMandateExpiry: true });
    await expect(strict.verify(sdk.vectors.closedMandate)).resolves.toBeDefined();
  });

  it('refuses the SDK mandate when the operator requires an audience it does not carry', async () => {
    const error = await refusal(
      verifierFor({ requireMandateAudience: true }).verify(sdk.vectors.closedMandate),
    );
    expect(error.details?.['reason']).toBe('invalid_claims');
  });

  it('refuses it once the exp inside the mandate content has passed', async () => {
    const later = new Date(MINTED_AT.getTime() + 3_600_000);
    const error = await refusal(verifierFor({}, later).verify(sdk.vectors.closedMandate));
    expect(error.details?.['reason']).toBe('expired');
  });

  it.each([
    ['an open mandate', 'openMandate'],
    ['a delegation chain ending in a KB-SD-JWT', 'delegatedChain'],
  ] as const)('refuses %s as a mandate type Direct mode does not verify', async (_label, name) => {
    const error = await refusal(verifierFor().verify(sdk.vectors[name]));
    expect(error.details?.['reason']).toBe('unsupported_mandate_type');
  });
});
