// The currency a payment records: the token an offer settles, not the price's label
import { describe, expect, it } from 'vitest';
import { requireX402Network } from '../../../src/payments/x402/networks';
import { offerCurrency } from '../../../src/payments/x402/provider/offers';
import type { Offer } from '../../../src/payments/x402/provider/types';

const offer = (network: string, asset: string) =>
  ({ profile: requireX402Network(network, 'test'), asset }) as unknown as Offer;

describe('offerCurrency', () => {
  it("names the network's default token, whatever the price says", () => {
    const usdc = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
    expect(offerCurrency(offer('eip155:84532', usdc), 'USD')).toBe('USDC');
    // EVM addresses compare without case
    expect(offerCurrency(offer('eip155:84532', usdc.toLowerCase()), 'USD')).toBe('USDC');
    expect(
      offerCurrency(
        offer('near:testnet', '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af'),
        'USD',
      ),
    ).toBe('USDC');
  });

  it("keeps the price's currency for a token it has no symbol for", () => {
    expect(offerCurrency(offer('eip155:84532', `0x${'12'.repeat(20)}`), 'EURC')).toBe('EURC');
    // The local chain has no default token
    expect(offerCurrency(offer('eip155:31337', `0x${'12'.repeat(20)}`), 'USD')).toBe('USD');
  });
});
