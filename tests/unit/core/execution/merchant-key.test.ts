import { describe, expect, it } from 'vitest';
import { inputDigest } from '../../../../src/core/execution/journal';
import { paidOperationKey } from '../../../../src/core/execution/merchant-key';

// Independent sha256sum fixtures detect format changes that could break merchant deduplication.
// Preimages use the digest of {"city":"Oslo"}:
// ["paid-operation","https://gw.example","report","<operation>","sha256:<digest>"]
const KEY_FOR_REPLAY_KEY = '3e51c13adef2740ac0e40798081fbfad6a01d86d64416f0b23bf344719313f75';
const KEY_FOR_CLIENT_KEY = '09eb5f9d837926ff77f3dcc000b09453d07ae3fa6325f2626ed43746acddcb7a';

const operation = {
  deployment: 'https://gw.example',
  resourceId: 'report',
  replayKey: '0xabc',
  inputDigest: inputDigest({ city: 'Oslo' }),
};
const retried = { ...operation, clientKey: 'client-key-1', payer: '0xPAYER' };

describe('paidOperationKey', () => {
  it('derives the key from the replay key without a client key', () => {
    expect(paidOperationKey(operation)).toBe(KEY_FOR_REPLAY_KEY);
  });

  it('derives the key from the client key and payer when both are known', () => {
    expect(paidOperationKey(retried)).toBe(KEY_FOR_CLIENT_KEY);
  });

  it('gives two proofs from one payer one key', () => {
    expect(paidOperationKey({ ...retried, replayKey: '0xdef' })).toBe(KEY_FOR_CLIENT_KEY);
  });

  it.each([
    ['payer', { payer: '0xOTHER' }],
    ['client key', { clientKey: 'client-key-2' }],
    ['input', { inputDigest: inputDigest({ city: 'Bergen' }) }],
    ['resource', { resourceId: 'other' }],
    ['deployment', { deployment: 'https://other.example' }],
  ])('gives another %s a different key', (_name, change) => {
    const key = paidOperationKey({ ...retried, ...change });

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toBe(KEY_FOR_CLIENT_KEY);
  });

  it('keeps a delimiter in one field from reaching the next', () => {
    const first = { ...operation, deployment: 'http://a', resourceId: '8080:report' };
    const second = { ...operation, deployment: 'http://a:8080', resourceId: 'report' };

    expect(paidOperationKey(first)).not.toBe(paidOperationKey(second));
  });

  it('gives another replay key a different key without a client key', () => {
    const key = paidOperationKey({ ...operation, replayKey: '0xdef' });

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toBe(KEY_FOR_REPLAY_KEY);
  });

  it.each([
    ['absent', {}],
    ['empty', { payer: '' }],
  ])('falls back to the replay key when the payer is %s', (_name, payer) => {
    const key = paidOperationKey({ ...operation, clientKey: 'client-key-1', ...payer });

    expect(key).toBe(KEY_FOR_REPLAY_KEY);
  });

  it('gives no key for input that is not I-JSON', () => {
    expect(
      paidOperationKey({ ...operation, inputDigest: inputDigest({ text: '\uD800' }) }),
    ).toBeUndefined();
  });
});
