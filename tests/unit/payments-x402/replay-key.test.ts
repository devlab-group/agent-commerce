import { describe, expect, it } from 'vitest';
import { computeReplayKey } from '../../../src/payments/x402/replay-key';

const BASE = {
  chainId: 84532,
  asset: '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const,
  from: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as const,
  nonce: `0x${'11'.repeat(32)}` as const,
};

describe('computeReplayKey', () => {
  it('is deterministic for the same authorization', () => {
    const a = computeReplayKey(BASE);
    const b = computeReplayKey(BASE);
    expect(a).toBe(b);
  });

  it('is independent of any request id - it only depends on the authorization', () => {
    // The signature takes no request id. Two identical authorizations, as a
    // replay on two requests would present, must produce the same key.
    const first = computeReplayKey(BASE);
    const second = computeReplayKey({ ...BASE });
    expect(first).toBe(second);
  });

  it('changes when the nonce changes', () => {
    const a = computeReplayKey(BASE);
    const b = computeReplayKey({ ...BASE, nonce: `0x${'22'.repeat(32)}` });
    expect(a).not.toBe(b);
  });

  it('changes when the payer changes', () => {
    const a = computeReplayKey(BASE);
    const b = computeReplayKey({ ...BASE, from: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' });
    expect(a).not.toBe(b);
  });

  it('changes when the asset changes', () => {
    const a = computeReplayKey(BASE);
    const b = computeReplayKey({ ...BASE, asset: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' });
    expect(a).not.toBe(b);
  });

  it('changes when the chain id changes', () => {
    const a = computeReplayKey(BASE);
    const b = computeReplayKey({ ...BASE, chainId: 1 });
    expect(a).not.toBe(b);
  });

  it('returns a 32-byte hex string', () => {
    const key = computeReplayKey(BASE);
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
