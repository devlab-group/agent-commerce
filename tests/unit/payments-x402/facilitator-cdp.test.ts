/**
 * The CDP auth type, and what happens when its optional peer is absent.
 *
 * `@coinbase/x402` is imported dynamically so that the majority — who use a
 * facilitator needing no credential at all — never install the CDP SDK and its
 * Solana/axios/JOSE tree. That laziness has a failure mode worth pinning: a
 * missing peer must be a *configuration* failure visible before anyone pays,
 * never an exception inside verify() with a buyer's authorisation already
 * spent.
 *
 * `vi.doMock` + `vi.resetModules` rather than a hoisted `vi.mock`: the two
 * cases below need the same specifier to resolve differently, which a single
 * hoisted factory cannot express.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FACILITATOR_URL = 'https://facilitator.example.com';

interface CapturedConfig {
  url: string;
  createAuthHeaders?: () => Promise<Record<string, Record<string, string>>>;
}

/** Captures what the binding hands to the SDK's HTTP client. */
function mockHttpClient(captured: CapturedConfig[]): void {
  vi.doMock('@x402/core/http', () => ({
    FacilitatorResponseError: class extends Error {},
    HTTPFacilitatorClient: class {
      constructor(config: CapturedConfig) {
        captured.push(config);
      }
      verify() {
        throw new Error('not used');
      }
      settle() {
        throw new Error('not used');
      }
      getSupported() {
        throw new Error('not used');
      }
    },
  }));
}

async function buildBinding(auth: {
  type: 'cdp';
  apiKeyId: string;
  apiKeySecret: string;
}): Promise<CapturedConfig> {
  const captured: CapturedConfig[] = [];
  mockHttpClient(captured);
  const { createRemoteFacilitatorBinding } = await import(
    '../../../src/payments/x402/facilitator.js'
  );
  createRemoteFacilitatorBinding({ url: FACILITATOR_URL, auth });
  const config = captured[0];
  if (!config) throw new Error('the binding built no HTTP client');
  return config;
}

describe('facilitator auth: cdp', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('@coinbase/x402');
    vi.doUnmock('@x402/core/http');
  });

  it('signs each request through @coinbase/x402, path-keyed as the SDK requires', async () => {
    const seen: Array<{ id: string; secret: string }> = [];
    vi.doMock('@coinbase/x402', () => ({
      createCdpAuthHeaders: (id: string, secret: string) => {
        seen.push({ id, secret });
        return async () => ({
          verify: { Authorization: 'Bearer jwt-verify' },
          settle: { Authorization: 'Bearer jwt-settle' },
          supported: { Authorization: 'Bearer jwt-supported' },
        });
      },
    }));

    const config = await buildBinding({
      type: 'cdp',
      apiKeyId: 'key-id',
      apiKeySecret: 'key-secret',
    });
    expect(config.url).toBe(FACILITATOR_URL);
    expect(config.createAuthHeaders).toBeDefined();

    const headers = await config.createAuthHeaders?.();
    // Per path, not flat: CDP signs over method + host + path, so one header
    // for every route would be wrong even if the SDK accepted it.
    expect(headers).toEqual({
      verify: { Authorization: 'Bearer jwt-verify' },
      settle: { Authorization: 'Bearer jwt-settle' },
      supported: { Authorization: 'Bearer jwt-supported' },
    });
    expect(seen).toEqual([{ id: 'key-id', secret: 'key-secret' }]);
  });

  it('turns a missing @coinbase/x402 into CONFIG_INVALID naming the peer', async () => {
    vi.doMock('@coinbase/x402', () => {
      throw new Error("Cannot find package '@coinbase/x402'");
    });

    const config = await buildBinding({
      type: 'cdp',
      apiKeyId: 'key-id',
      apiKeySecret: 'key-secret',
    });

    // Construction itself must not throw — the provider is built
    // synchronously, and the diagnosis belongs where it can be reported.
    expect(config.createAuthHeaders).toBeDefined();
    // Imported here, not at the top of the file: `vi.resetModules()` gives the
    // module under test a fresh graph, and a `CommerceError` from the outer
    // graph is a different class — `instanceof` across the two is false.
    const { isCommerceError } = await import('../../../src/core/index.js');
    await expect(config.createAuthHeaders?.()).rejects.toSatisfy(
      (err: unknown) =>
        isCommerceError(err) &&
        err.code === 'CONFIG_INVALID' &&
        err.message.includes('@coinbase/x402'),
    );
  });

  it('never puts the credential in anything the binding describes', async () => {
    vi.doMock('@coinbase/x402', () => ({
      createCdpAuthHeaders: () => async () => ({}),
    }));
    mockHttpClient([]);
    const { createRemoteFacilitatorBinding } = await import(
      '../../../src/payments/x402/facilitator.js'
    );
    const binding = createRemoteFacilitatorBinding({
      url: FACILITATOR_URL,
      auth: { type: 'cdp', apiKeyId: 'key-id', apiKeySecret: 'super-secret' },
    });
    // `describe` reaches logs, health details and doctor output.
    expect(binding.describe).not.toContain('super-secret');
    expect(binding.describe).not.toContain('key-id');
    expect(binding.describe).toContain('auth=cdp');
  });
});
