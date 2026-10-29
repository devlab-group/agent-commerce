// Allowed locator fields and a receipt-store persistence check
import { expect } from 'vitest';
import type { PaymentResult } from '../../../src/core';
import { RECONCILIATION_METADATA_KEY } from '../../../src/core';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';

// Public transfer details and derived metadata; no signatures or payloads
const LOCATOR_FIELDS = {
  eip3009: [
    'v',
    'network',
    'method',
    'asset',
    'from',
    'to',
    'value',
    'nonce',
    'validAfter',
    'validBefore',
    'expiresAt',
  ],
  permit2: [
    'v',
    'network',
    'method',
    'asset',
    'owner',
    'to',
    'amount',
    'nonce',
    'deadline',
    'validAfter',
    'proxy',
    'expiresAt',
  ],
  svm: ['v', 'network', 'messageHash', 'recentBlockhash', 'payer'],
  near: [
    'v',
    'network',
    'senderId',
    'publicKey',
    'nonce',
    'maxBlockHeight',
    'asset',
    'receiver',
    'amount',
    'relayers',
  ],
} as const;

/** The locator a verification carries */
export function locatorOf(verification: PaymentResult): Readonly<Record<string, unknown>> {
  return verification.metadata?.[RECONCILIATION_METADATA_KEY] as Readonly<Record<string, unknown>>;
}

/**
 * Checks the family's allowed fields and verifies that the journal stores the
 * locator unchanged, including through receipt-store redaction
 */
export async function expectStoredLocator(
  locator: Readonly<Record<string, unknown>>,
  family: keyof typeof LOCATOR_FIELDS,
): Promise<void> {
  const allowed: readonly string[] = LOCATOR_FIELDS[family];
  expect(Object.keys(locator).filter((key) => !allowed.includes(key))).toEqual([]);

  const store = createSqliteReceiptStore({ path: ':memory:' });
  await store.reservePaymentAttempt({
    requestId: 'req-1',
    resourceId: 'demo.report',
    provider: 'x402',
    replayKey: 'replay-key-1',
    amount: '0.01',
    currency: 'USDC',
    transaction: { id: 'txn-1', protocol: 'http', locator, configDigest: 'sha256:0' },
  });
  expect((await store.getTransaction?.('txn-1'))?.payment.locator).toStrictEqual(locator);
}
