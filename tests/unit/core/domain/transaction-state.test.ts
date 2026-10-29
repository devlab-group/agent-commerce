// Check transaction states across payment outcomes, backend results and deadline boundaries
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type PaymentAttempt,
  type TransactionFacts,
  type TransactionState,
  transactionState,
} from '../../../../src/core';

const NOW = '2026-10-28T12:00:00.000Z';
const DISPATCHED = '2026-10-28T11:59:00.000Z';
const FUTURE_DEADLINE = '2026-10-28T12:01:00.000Z';
const PAST_DEADLINE = '2026-10-28T11:59:30.000Z';
const COMPLETED = '2026-10-28T11:59:10.000Z';

type Backend = NonNullable<TransactionFacts['backend']>;

function facts(
  status: PaymentAttempt['status'],
  backend?: Partial<Backend>,
  completed = false,
): TransactionFacts {
  return {
    payment: { status },
    ...(backend !== undefined
      ? { backend: { dispatchedAt: DISPATCHED, deadlineAt: FUTURE_DEADLINE, ...backend } }
      : {}),
    ...(completed ? { completedAt: COMPLETED } : {}),
  };
}

describe('transactionState', () => {
  describe('an attempt whose settlement outcome is unknown', () => {
    it.each([
      ['settlement-uncertain', undefined, false],
      ['settlement-uncertain', { status: 200 }, true],
      ['failed', undefined, false],
      ['failed', { status: 200 }, true],
    ] as const)(
      '%s with backend %j, completed %s, is payment-uncertain',
      (status, backend, completed) => {
        expect(transactionState(facts(status, backend, completed), NOW)).toBe('payment-uncertain');
      },
    );
  });

  describe('a rejected attempt', () => {
    it.each([
      [undefined, false],
      [{ status: 500 }, true],
      [{ status: 200 }, true],
    ] as const)('with backend %j, completed %s, is payment-failed', (backend, completed) => {
      expect(transactionState(facts('rejected', backend, completed), NOW)).toBe('payment-failed');
    });
  });

  describe('a payment not yet final', () => {
    it.each([
      ['reserved', 'delivery-started', 'dispatched, no result, before the deadline', {}, false],
      ['verified', 'delivery-started', 'dispatched, no result, before the deadline', {}, false],
      ['reserved', 'payment-pending', 'never dispatched', undefined, false],
      [
        'reserved',
        'payment-pending',
        'dispatched, no result, past the deadline',
        { deadlineAt: PAST_DEADLINE },
        false,
      ],
      [
        'reserved',
        'payment-pending',
        'dispatched, no result, deadline exactly now',
        { deadlineAt: NOW },
        false,
      ],
      [
        'reserved',
        'payment-pending',
        'backend answered 2xx, settlement still to come',
        { status: 200 },
        false,
      ],
      ['reserved', 'payment-pending', 'backend failed', { status: 503 }, false],
      ['reserved', 'payment-pending', 'dispatched, no result, flow completed', {}, true],
    ] as const)('%s is %s when %s', (status, expected, _case, backend, completed) => {
      expect(transactionState(facts(status, backend, completed), NOW)).toBe(expected);
    });
  });

  describe('a settled payment', () => {
    it.each([
      ['settled-undelivered', 'the backend was never dispatched', undefined, false],
      [
        'settled-undelivered',
        'the backend was never dispatched and the flow completed',
        undefined,
        true,
      ],
      ['settled-undelivered', 'the backend answered 500', { status: 500 }, true],
      [
        'settled-undelivered',
        'the backend answered 404 before the deadline',
        { status: 404 },
        false,
      ],
      ['settled-undelivered', 'the backend answered 300', { status: 300 }, true],
      ['settled-undelivered', 'the backend answered 199', { status: 199 }, true],
      ['delivered', 'the backend answered 200 and the flow completed', { status: 200 }, true],
      ['delivered', 'the backend answered 299 and the flow completed', { status: 299 }, true],
      ['delivery-started', 'the backend has not answered before the deadline', {}, false],
      [
        'delivery-started',
        'the backend answered 2xx and the flow has not completed, before the deadline',
        { status: 201 },
        false,
      ],
      [
        'delivery-unknown',
        'the backend has not answered past the deadline',
        { deadlineAt: PAST_DEADLINE },
        false,
      ],
      [
        'delivery-unknown',
        'the backend has not answered, deadline exactly now',
        { deadlineAt: NOW },
        false,
      ],
      [
        'delivery-unknown',
        'the backend answered 2xx and the flow never completed, past the deadline',
        { status: 200, deadlineAt: PAST_DEADLINE },
        false,
      ],
      [
        'delivery-unknown',
        'the call ended without a status (0), before the deadline',
        { status: 0 },
        false,
      ],
      [
        'delivery-unknown',
        'the call ended without a status (0) and the flow completed',
        { status: 0 },
        true,
      ],
      ['delivery-unknown', 'the flow completed without a recorded backend result', {}, true],
    ] as const)('is %s when %s', (expected, _case, backend, completed) => {
      expect(transactionState(facts('settled', backend, completed), NOW)).toBe(expected);
    });
  });

  it('treats an unparseable deadline as passed, never as still waiting', () => {
    expect(transactionState(facts('settled', { deadlineAt: 'not-a-time' }), NOW)).toBe(
      'delivery-unknown',
    );
    expect(transactionState(facts('reserved', { deadlineAt: 'not-a-time' }), NOW)).toBe(
      'payment-pending',
    );
  });

  it('accepts state names it does not list, which later releases add', () => {
    expectTypeOf<'in-remediation'>().toMatchTypeOf<TransactionState>();
  });
});
