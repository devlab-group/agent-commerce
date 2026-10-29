// MCP and A2A delivery summaries keep the 2.4.1 wire format without a receipt
// failure; failed saves retain receiptId and add receiptCommitted: false
import { describe, expect, it } from 'vitest';
import { DELIVERY_SUMMARY_META_KEY, type DeliveredOutcome } from '../../src/core';
import { completedTask } from '../../src/protocols/a2a/task-mapping';
import { mapOutcome } from '../../src/protocols/mcp/result-mapping';

const delivered: DeliveredOutcome = {
  kind: 'delivered',
  requestId: 'req-1',
  transactionId: 'txn-1',
  resourceId: 'market_report',
  backendStatus: 200,
  body: { report: 'ok' },
  payment: {
    status: 'settled',
    provider: 'x402',
    amount: '0.01',
    currency: 'USDC',
    network: 'eip155:31337',
    payer: '0xBUYER',
    externalReference: '0xsettled',
  },
  receipt: {
    id: 'receipt-1',
    requestId: 'req-1',
    resourceId: 'market_report',
    deliveredAt: '2026-01-01T00:00:00.000Z',
    backendStatus: 200,
    transactionId: 'txn-1',
  },
  durationMs: 5,
};

// Expected 2.4.1 delivery summary, which omits transactionId
const SUMMARY_2_4_1 =
  '{"requestId":"req-1","resourceId":"market_report","receiptId":"receipt-1",' +
  '"deliveredAt":"2026-01-01T00:00:00.000Z","payment":{"status":"settled","amount":"0.01",' +
  '"currency":"USDC","externalReference":"0xsettled","network":"eip155:31337"}}';

const UNCOMMITTED = {
  requestId: 'req-1',
  resourceId: 'market_report',
  receiptId: 'receipt-1',
  receiptCommitted: false,
  deliveredAt: '2026-01-01T00:00:00.000Z',
  payment: {
    status: 'settled',
    amount: '0.01',
    currency: 'USDC',
    externalReference: '0xsettled',
    network: 'eip155:31337',
  },
};

const identity = {
  taskId: 'req-1',
  contextId: 'ctx-1',
  artifactId: 'artifact-1',
  statusMessageId: 'msg-1',
  timestamp: '2026-01-01T00:00:00.000Z',
};

const summaries = {
  mcp: (outcome: DeliveredOutcome) => mapOutcome(outcome)._meta?.[DELIVERY_SUMMARY_META_KEY],
  a2a: (outcome: DeliveredOutcome) =>
    completedTask(outcome, identity).artifacts[0]?.metadata?.[DELIVERY_SUMMARY_META_KEY],
};

describe.each(Object.entries(summaries))('the %s delivery summary', (_protocol, summaryOf) => {
  it('serializes byte for byte as in 2.4.1 when the receipt was saved', () => {
    expect(JSON.stringify(summaryOf(delivered))).toBe(SUMMARY_2_4_1);
    expect(
      JSON.stringify(
        summaryOf({ ...delivered, persistenceFailures: ['payment-attempt', 'journal'] }),
      ),
    ).toBe(SUMMARY_2_4_1);
  });

  it('keeps the receipt id and adds receiptCommitted: false when the receipt write failed', () => {
    expect(summaryOf({ ...delivered, persistenceFailures: ['receipt'] })).toStrictEqual(
      UNCOMMITTED,
    );
  });
});
