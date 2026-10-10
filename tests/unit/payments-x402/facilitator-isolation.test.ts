/**
 * Verify that the remote binding loads without the EVM stack and preserves
 * `/supported` metadata. The mocks throw if an import loads an EVM dependency
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('viem', () => {
  throw new Error('viem was loaded');
});
vi.mock('@x402/evm', () => {
  throw new Error('@x402/evm was loaded');
});
vi.mock('@x402/evm/exact/facilitator', () => {
  throw new Error('@x402/evm/exact/facilitator was loaded');
});
vi.mock('@x402/core/facilitator', () => {
  throw new Error('@x402/core/facilitator was loaded');
});

// Trimmed x402.org response: retain the Solana fee payer needed to build offers
const SUPPORTED = {
  kinds: [
    { x402Version: 2, scheme: 'exact', network: 'eip155:84532' },
    {
      x402Version: 2,
      scheme: 'exact',
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      extra: { feePayer: 'CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5' },
    },
  ],
  extensions: ['eip2612GasSponsoring'],
  signers: { 'solana:*': ['CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5'] },
};

let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    // A facilitator that rate-limits `/supported` and asks for a long wait
    if (req.url === '/limited/supported') {
      res.statusCode = 429;
      res.setHeader('retry-after', '30');
      res.end();
      return;
    }
    if (req.url === '/supported') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(SUPPORTED));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('remote facilitator binding', () => {
  it('loads without the EVM stack and keeps the whole /supported answer', async () => {
    const { createRemoteFacilitatorBinding } = await import(
      '../../../src/payments/x402/facilitator'
    );
    const binding = createRemoteFacilitatorBinding({ url, auth: { type: 'none' } });
    if (binding.kind !== 'remote') throw new Error('expected a remote binding');
    expect(await binding.supported()).toEqual(SUPPORTED);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The SDK retries a 429 after its Retry-After; readiness and Solana
  // challenges wait on `/supported`, so the binding bounds the whole read
  it('gives up on /supported at its deadline, retry waits included', async () => {
    const { createRemoteFacilitatorBinding, SUPPORTED_TIMEOUT_MS } = await import(
      '../../../src/payments/x402/facilitator'
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const binding = createRemoteFacilitatorBinding({
      url: `${url}/limited`,
      auth: { type: 'none' },
    });
    if (binding.kind !== 'remote') throw new Error('expected a remote binding');

    const read = binding.supported();
    const outcome = expect(read).rejects.toMatchObject({
      code: 'PAYMENT_PROVIDER_UNAVAILABLE',
      message: expect.stringContaining('did not answer within 10 s'),
    });
    await vi.advanceTimersByTimeAsync(SUPPORTED_TIMEOUT_MS);
    await outcome;
  });
});
