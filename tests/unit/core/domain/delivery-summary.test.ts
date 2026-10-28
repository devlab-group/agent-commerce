// A failed receipt write adds receiptCommitted: false while keeping receiptId;
// other persistence failures leave the wire format unchanged
import { describe, expect, it } from 'vitest';
import { type DeliveredOutcome, toDeliverySummary } from '../../../../src/core';

const outcome: DeliveredOutcome = {
  kind: 'delivered',
  requestId: 'req_1',
  resourceId: 'market_report',
  backendStatus: 200,
  body: { report: 'ok' },
  payment: {
    status: 'settled',
    provider: 'x402',
    amount: '1.00',
    currency: 'USDC',
    network: 'eip155:31337',
    externalReference: '0xabc',
  },
  receipt: {
    id: 'receipt_1',
    requestId: 'req_1',
    resourceId: 'market_report',
    deliveredAt: '2026-10-28T12:00:00.000Z',
    backendStatus: 200,
  },
  durationMs: 5,
};

// Expected wire format when no receipt persistence failure is reported
const UNCHANGED =
  '{"requestId":"req_1","resourceId":"market_report","receiptId":"receipt_1",' +
  '"deliveredAt":"2026-10-28T12:00:00.000Z","payment":{"status":"settled","amount":"1.00",' +
  '"currency":"USDC","externalReference":"0xabc","network":"eip155:31337"}}';

describe('toDeliverySummary', () => {
  it('serializes a delivery with no persistence failure byte for byte as before', () => {
    expect(JSON.stringify(toDeliverySummary(outcome))).toBe(UNCHANGED);
  });

  it('leaves the summary unchanged when only writes other than the receipt failed', () => {
    const summary = toDeliverySummary({
      ...outcome,
      persistenceFailures: ['payment-attempt', 'journal'],
    });
    expect(JSON.stringify(summary)).toBe(UNCHANGED);
  });

  it('keeps the receipt id and adds receiptCommitted: false when the receipt write failed', () => {
    const summary = toDeliverySummary({ ...outcome, persistenceFailures: ['receipt'] });
    expect(summary).toStrictEqual({
      requestId: 'req_1',
      resourceId: 'market_report',
      receiptId: 'receipt_1',
      receiptCommitted: false,
      deliveredAt: '2026-10-28T12:00:00.000Z',
      payment: {
        status: 'settled',
        amount: '1.00',
        currency: 'USDC',
        externalReference: '0xabc',
        network: 'eip155:31337',
      },
    });
  });
});
