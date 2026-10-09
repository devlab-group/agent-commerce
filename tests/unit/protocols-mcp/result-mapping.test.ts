import { describe, expect, it } from 'vitest';
import { CommerceError } from '../../../src/core';
import { errorResult } from '../../../src/protocols/mcp/result-mapping';

describe('errorResult', () => {
  // Finished replays return a fresh challenge with the paid network's replay code
  it.each([
    ['near:testnet', 'invalid_exact_near_payload_delegate_action_nonce_already_used'],
    ['solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', 'duplicate_settlement'],
    ['eip155:84532', 'invalid_exact_evm_nonce_already_used'],
  ])('gives an x402 replay on %s its family code', (network, code) => {
    const replay = new CommerceError(
      'PAYMENT_REPLAYED',
      'Payment authorization has already been used',
      {
        httpStatus: 402,
        details: { attemptStatus: 'settled', network, challenge: { x402Version: 2, accepts: [] } },
      },
    );

    const result = errorResult(replay, 'x402');

    expect(result._meta?.['x402/error']).toMatchObject({ error: code });
  });
});
