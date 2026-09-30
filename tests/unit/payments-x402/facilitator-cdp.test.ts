/**
 * The CDP auth type, and what happens when its optional peer is absent. A
 * missing `@coinbase/x402` must not throw at construction. It must surface as
 * a CONFIG_INVALID that the health check can report before anyone pays.
 *
 * `vi.doMock` + `vi.resetModules` rather than a hoisted `vi.mock`: the two
 * cases need the same specifier to resolve differently, which one hoisted
 * factory cannot express.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FACILITATOR_URL = 'https://facilitator.example.com';

interface CapturedConfig {
  url: string;
  createAuthHeaders?: () => Promise<Record<string, Record<string, string>>>;
}

// Captures what the binding hands to the SDK's HTTP client
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
  const { createRemoteFacilitatorBinding } = await import('../../../src/payments/x402/facilitator');
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
    // Per path, not flat: the JWT is signed over method, host and path, so one
    // header for every route would be wrong even if the SDK accepted it
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

    // Construction must not throw: the provider is built synchronously, and
    // the diagnosis belongs where it can be reported
    expect(config.createAuthHeaders).toBeDefined();
    // Imported here, not at the top: `vi.resetModules()` gives the module under
    // test a fresh graph, and `instanceof` against the outer graph's
    // `CommerceError` would be false
    const { isCommerceError } = await import('../../../src/core');
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
      '../../../src/payments/x402/facilitator'
    );
    const binding = createRemoteFacilitatorBinding({
      url: FACILITATOR_URL,
      auth: { type: 'cdp', apiKeyId: 'key-id', apiKeySecret: 'super-secret' },
    });
    // `describe` reaches logs, health details and doctor output
    expect(binding.describe).not.toContain('super-secret');
    expect(binding.describe).not.toContain('key-id');
    expect(binding.describe).toContain('auth=cdp');
  });
});
