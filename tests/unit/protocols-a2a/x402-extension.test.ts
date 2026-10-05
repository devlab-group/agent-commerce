import { describe, expect, it } from 'vitest';
import { CommerceError } from '../../../src/core';
import {
  A2A_X402_EXTENSION_URI,
  createPendingPayments,
  paymentFailureMetadata,
  readFollowUpAuthorization,
  readPaymentSubmission,
  requestsX402Extension,
} from '../../../src/protocols/a2a/x402-extension';

function clockAt(start: number) {
  let now = start;
  return {
    clock: {
      now: () => new Date(now),
      nowIso: () => new Date(now).toISOString(),
      monotonicMs: () => now,
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

const PURCHASE = { contextId: 'ctx-1', resourceId: 'report', input: {} };

describe('requestsX402Extension', () => {
  it.each([
    [A2A_X402_EXTENSION_URI, true],
    [`https://example.com/other/v1, ${A2A_X402_EXTENSION_URI}`, true],
    [['https://example.com/other/v1', A2A_X402_EXTENSION_URI], true],
    [`${A2A_X402_EXTENSION_URI}x`, false],
    ['https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2', false],
    [undefined, false],
  ])('reads %j as %s', (header, expected) => {
    expect(requestsX402Extension(header)).toBe(expected);
  });
});

describe('pending x402 payments', () => {
  it('holds a purchase until the requirement expires', () => {
    const time = clockAt(Date.parse('2026-10-05T00:00:00Z'));
    const pending = createPendingPayments(time.clock);
    pending.put('task-1', PURCHASE, '2026-10-05T00:01:00Z');

    time.advance(59_000);
    expect(pending.get('task-1')).toMatchObject(PURCHASE);
    time.advance(1_000);
    expect(pending.get('task-1')).toBeUndefined();
  });

  it('caps a pending task at one hour', () => {
    const time = clockAt(Date.parse('2026-10-05T00:00:00Z'));
    const pending = createPendingPayments(time.clock);
    pending.put('task-1', PURCHASE, '2026-10-06T00:00:00Z');

    time.advance(3_600_000);
    expect(pending.get('task-1')).toBeUndefined();
  });

  it('evicts the oldest purchase when full', () => {
    const pending = createPendingPayments(clockAt(0).clock, 2);
    pending.put('task-1', PURCHASE);
    pending.put('task-2', PURCHASE);
    pending.put('task-3', PURCHASE);

    expect(pending.get('task-1')).toBeUndefined();
    expect(pending.get('task-2')).toBeDefined();
    expect(pending.get('task-3')).toBeDefined();
    expect(pending.size()).toBe(2);
  });
});

describe('payment messages', () => {
  it.each([
    [{ 'x402.payment.status': 'payment-submitted', 'x402.payment.payload': { a: 1 } }, 'submitted'],
    [{ 'x402.payment.status': 'payment-rejected' }, 'rejected'],
    [{ 'x402.payment.status': 'payment-submitted' }, undefined],
    [{ 'x402.payment.status': 'payment-submitted', 'x402.payment.payload': 'x' }, undefined],
    [{ 'x402.payment.status': 'payment-verified' }, undefined],
  ])('reads metadata %j as %s', (metadata, kind) => {
    expect(readPaymentSubmission({ metadata })?.kind).toBe(kind);
  });

  it('reports a backend failure after settlement as a completed payment', () => {
    const error = new CommerceError('BACKEND_ERROR', 'Backend failed', {
      details: {
        payment: {
          status: 'settled',
          provider: 'x402',
          currency: 'USDC',
          network: 'eip155:84532',
          externalReference: '0xabc',
        },
      },
    });

    expect(paymentFailureMetadata(error)).toMatchObject({
      'x402.payment.status': 'payment-completed',
      'x402.payment.receipts': [{ success: true, transaction: '0xabc' }],
    });
  });

  it('preserves a backend error code when no payment settled', () => {
    const error = new CommerceError('BACKEND_ERROR', 'Backend failed');

    expect(paymentFailureMetadata(error)).toMatchObject({
      'x402.payment.status': 'payment-failed',
      'x402.payment.error': 'backend_error',
      'x402.payment.receipts': [{ success: false, errorReason: 'backend_error' }],
    });
  });

  it('keeps settlement_pending for a settlement without a verdict', () => {
    const error = new CommerceError('PAYMENT_SETTLEMENT_FAILED', 'Settlement unconfirmed', {
      details: { settlementUncertain: true, transactionHash: '0xdef' },
    });

    expect(paymentFailureMetadata(error)).toMatchObject({
      'x402.payment.status': 'payment-failed',
      'x402.payment.receipts': [{ success: false, errorReason: 'settlement_pending' }],
    });
  });

  it('fills an empty receipt network from the requirement and keeps one the error names', () => {
    const refused = new CommerceError('PAYMENT_INVALID', 'Refused', {
      details: { reason: 'insufficient_funds' },
    });
    expect(paymentFailureMetadata(refused, 'eip155:84532')).toMatchObject({
      'x402.payment.receipts': [{ success: false, network: 'eip155:84532' }],
    });

    const named = new CommerceError('PAYMENT_SETTLEMENT_FAILED', 'Refused', {
      details: { reason: 'unexpected_settle_error', network: 'eip155:8453' },
    });
    expect(paymentFailureMetadata(named, 'eip155:84532')).toMatchObject({
      'x402.payment.receipts': [{ network: 'eip155:8453' }],
    });
  });
});

describe('readFollowUpAuthorization', () => {
  const envelope = { method: 'ap2', payload: 'mandate~' };

  it('reads input._authorization from a data part and ignores the rest of the part', () => {
    const message = {
      parts: [
        { text: 'Here is the payment.' },
        { data: { resource: 'another', input: { city: 'Oslo', _authorization: envelope } } },
      ],
    };
    expect(readFollowUpAuthorization(message)).toEqual(envelope);
  });

  it('returns undefined when no part carries one', () => {
    expect(readFollowUpAuthorization({ parts: [{ text: 'pay' }, { data: { input: {} } }] })).toBe(
      undefined,
    );
    expect(readFollowUpAuthorization({})).toBe(undefined);
  });

  it('throws AUTHORIZATION_INVALID for a malformed envelope', () => {
    expect(() =>
      readFollowUpAuthorization({ parts: [{ data: { input: { _authorization: 'nope' } } }] }),
    ).toThrow(expect.objectContaining({ code: 'AUTHORIZATION_INVALID' }));
  });
});
