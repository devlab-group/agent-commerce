/**
 * Exercises health()'s pass/warn/fail branches by mocking the local public
 * client it builds (`../src/chain.js`), rather than requiring a live chain —
 * `health()` must never throw and must classify every RPC/chain-state
 * outcome correctly; each of those outcomes is independent of any real
 * network and is cheap to force directly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clock } from '../../../src/core/index.js';

const getChainIdMock = vi.fn();
const getCodeMock = vi.fn();
const requestMock = vi.fn();
const supportedMock = vi.fn();

vi.mock('../../../src/payments/x402/facilitator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/payments/x402/facilitator.js')>();
  return {
    ...actual,
    // The remote binding's only job in health() is to report what the
    // facilitator advertises; the HTTP call itself belongs to the SDK.
    createRemoteFacilitatorBinding: () => ({
      kind: 'remote' as const,
      describe: 'remote https://facilitator.invalid (auth=none)',
      open: () => {
        throw new Error('health() must not open a facilitator session');
      },
      supported: () => supportedMock(),
    }),
  };
});

vi.mock('../../../src/payments/x402/chain.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/payments/x402/chain.js')>();
  return {
    ...actual,
    createLocalPublicClient: () => ({
      getChainId: () => getChainIdMock(),
      getCode: (...args: unknown[]) => getCodeMock(...args),
      request: (...args: unknown[]) => requestMock(...args),
    }),
  };
});

/** Anvil actually answers this; a real RPC returns a JSON-RPC error. */
function mockAsGenuineAnvilNode(): void {
  requestMock.mockResolvedValueOnce({ clientVersion: 'anvil/v1.1.0' });
}

const ASSET = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;
const PAY_TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
/** A dev payTo is refused on any non-local deployment, so remote mode needs a real one. */
const REMOTE_PAY_TO = '0x1111111111111111111111111111111111111111' as const;
const BUYER_PRIVATE_KEY =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;

async function makeProvider(facilitatorMode: 'local' | 'remote' = 'local', clock?: Clock) {
  const { createX402PaymentProvider } = await import('../../../src/payments/x402/provider.js');
  return createX402PaymentProvider({
    network: 'eip155:84532',
    rpcUrl: 'http://127.0.0.1:19322',
    asset: ASSET,
    assetName: 'MockUSDC',
    assetVersion: '2',
    assetDecimals: 6,
    payTo: facilitatorMode === 'local' ? PAY_TO : REMOTE_PAY_TO,
    facilitator:
      facilitatorMode === 'local'
        ? { mode: 'local', signerPrivateKey: BUYER_PRIVATE_KEY }
        : { mode: 'remote', url: 'https://facilitator.invalid', auth: { type: 'none' } },
    ...(clock ? { clock } : {}),
  });
}

/** Controllable monotonicMs() for cache-TTL tests — advance() moves it forward explicitly. */
function makeFakeClock(startMs = 0): { clock: Clock; advance: (deltaMs: number) => void } {
  let ms = startMs;
  return {
    clock: {
      now: () => new Date(ms),
      nowIso: () => new Date(ms).toISOString() as ReturnType<Clock['nowIso']>,
      monotonicMs: () => ms,
    },
    advance: (deltaMs: number) => {
      ms += deltaMs;
    },
  };
}

describe('health() — mocked RPC client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes when chain id matches, the asset has code, and the RPC confirms it is Anvil', async () => {
    getChainIdMock.mockResolvedValueOnce(84532);
    getCodeMock.mockResolvedValueOnce('0x6080604052');
    mockAsGenuineAnvilNode();
    const provider = await makeProvider();
    const health = await provider.health();
    expect(health.status).toBe('pass');
  });

  it('fails when the chain id matches (84532) but the RPC does not answer anvil_nodeInfo — e.g. real Base Sepolia', async () => {
    getChainIdMock.mockResolvedValueOnce(84532);
    getCodeMock.mockResolvedValueOnce('0x6080604052');
    requestMock.mockRejectedValueOnce(new Error('the method anvil_nodeInfo does not exist'));
    const provider = await makeProvider();
    const health = await provider.health();
    expect(health.status).toBe('fail');
    expect(health.detail).toContain('anvil_nodeInfo');
  });

  it('passes for a remote facilitator that advertises our scheme and network, without probing anvil_nodeInfo', async () => {
    getChainIdMock.mockResolvedValueOnce(84532);
    getCodeMock.mockResolvedValueOnce('0x6080604052');
    supportedMock.mockResolvedValueOnce([
      { x402Version: 2, scheme: 'exact', network: 'eip155:84532' },
    ]);
    const provider = await makeProvider('remote');
    const health = await provider.health();
    expect(health.status).toBe('pass');
    expect(health.detail).toContain('TESTNET');
    // The Anvil probe is a local-mode question; a public facilitator is not
    // expected to answer it and must never be judged on it.
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('fails when the remote facilitator does not advertise our scheme on our network', async () => {
    // A facilitator that is up but cannot settle this pair fails every
    // payment — and does it after the buyer has already signed.
    getChainIdMock.mockResolvedValueOnce(84532);
    getCodeMock.mockResolvedValueOnce('0x6080604052');
    supportedMock.mockResolvedValueOnce([
      { x402Version: 2, scheme: 'exact', network: 'eip155:8453' },
    ]);
    const provider = await makeProvider('remote');
    const health = await provider.health();
    expect(health.status).toBe('fail');
    expect(health.detail).toContain('does not advertise');
  });

  it('fails when the chain id does not match', async () => {
    getChainIdMock.mockResolvedValueOnce(1);
    const provider = await makeProvider();
    const health = await provider.health();
    expect(health.status).toBe('fail');
    expect(health.detail).toContain('chain id');
  });

  it('fails when the asset address has no code', async () => {
    getChainIdMock.mockResolvedValueOnce(84532);
    getCodeMock.mockResolvedValueOnce('0x');
    const provider = await makeProvider();
    const health = await provider.health();
    expect(health.status).toBe('fail');
    expect(health.detail).toContain('No contract code');
  });

  it('fails when getCode returns undefined', async () => {
    getChainIdMock.mockResolvedValueOnce(84532);
    getCodeMock.mockResolvedValueOnce(undefined);
    const provider = await makeProvider();
    const health = await provider.health();
    expect(health.status).toBe('fail');
  });

  it('never throws — catches an unexpected client error and reports fail', async () => {
    getChainIdMock.mockRejectedValueOnce(new Error('boom'));
    const provider = await makeProvider();
    const health = await provider.health();
    expect(health.status).toBe('fail');
    expect(health.detail).toContain('boom');
  });
});

describe('health() — caching / single-flight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('collapses a burst of concurrent calls into a single underlying probe', async () => {
    getChainIdMock.mockResolvedValueOnce(84532);
    getCodeMock.mockResolvedValueOnce('0x6080604052');
    mockAsGenuineAnvilNode();
    const provider = await makeProvider();

    const results = await Promise.all(Array.from({ length: 20 }, () => provider.health()));

    expect(getChainIdMock).toHaveBeenCalledTimes(1);
    expect(getCodeMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledTimes(1);
    for (const result of results) expect(result.status).toBe('pass');
  });

  it('serves the cached result for a second call within the TTL — no new RPC round-trip', async () => {
    getChainIdMock.mockResolvedValueOnce(84532);
    getCodeMock.mockResolvedValueOnce('0x6080604052');
    mockAsGenuineAnvilNode();
    const { clock, advance } = makeFakeClock();
    const provider = await makeProvider('local', clock);

    const first = await provider.health();
    advance(1_000); // well under the 5s TTL
    const second = await provider.health();

    expect(getChainIdMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('issues a fresh probe once the TTL elapses', async () => {
    getChainIdMock.mockResolvedValueOnce(84532);
    getCodeMock.mockResolvedValueOnce('0x6080604052');
    mockAsGenuineAnvilNode();
    const { clock, advance } = makeFakeClock();
    const provider = await makeProvider('local', clock);

    await provider.health();
    expect(getChainIdMock).toHaveBeenCalledTimes(1);

    advance(5_001); // just past the 5s TTL
    getChainIdMock.mockResolvedValueOnce(1); // chain id now mismatched — proves this is a real second probe
    const second = await provider.health();

    expect(getChainIdMock).toHaveBeenCalledTimes(2);
    expect(second.status).toBe('fail');
  });

  it("caches a fail result for the same TTL as a pass — symmetric on purpose (see health()'s doc comment)", async () => {
    getChainIdMock.mockRejectedValueOnce(new Error('connection refused'));
    const { clock, advance } = makeFakeClock();
    const provider = await makeProvider('local', clock);

    const first = await provider.health();
    advance(1_000);
    const second = await provider.health();

    expect(first.status).toBe('fail');
    expect(getChainIdMock).toHaveBeenCalledTimes(1); // second call served from cache, not re-probed
    expect(second).toEqual(first);
  });
});
