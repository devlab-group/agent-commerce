// Pipeline refusals after a payment follow-up consumes the task
import { describe, expect, it, vi } from 'vitest';
import {
  type Clock,
  CommerceError,
  type Logger,
  type ProtocolAdapterContext,
} from '../../../src/core';
import { resumePayment } from '../../../src/protocols/a2a/payment-resume';
import type { A2aTask } from '../../../src/protocols/a2a/types';
import { createPendingPayments } from '../../../src/protocols/a2a/x402-extension';

const NOW = Date.parse('2026-11-07T00:00:00.000Z');
const clock: Clock = {
  now: () => new Date(NOW),
  nowIso: () => new Date(NOW).toISOString(),
  monotonicMs: () => NOW,
};
const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

async function resumeWith(refusal: CommerceError) {
  const pendingPayments = createPendingPayments(clock);
  await pendingPayments.put('task-1', { contextId: 'ctx-1', resourceId: 'report', input: {} });
  let n = 0;
  const context = {
    pipeline: { execute: vi.fn().mockRejectedValue(refusal) },
    logger,
    clock,
    ids: { next: (prefix = 'id') => `${prefix}-${++n}` },
  } as unknown as ProtocolAdapterContext;
  const message = {
    taskId: 'task-1',
    messageId: 'msg-1',
    role: 'ROLE_USER',
    metadata: {
      'x402.payment.status': 'payment-submitted',
      'x402.payment.payload': { scheme: 'exact' },
    },
  };

  const response = await resumePayment(context, pendingPayments, 1, { message });
  const task = (response as { result: { task: A2aTask } }).result.task;
  const envelope = task.artifacts?.[0]?.parts[0]?.data as Record<string, unknown>;
  return { task, envelope, pendingPayments };
}

describe('resumePayment pipeline refusals', () => {
  it('does not tell the client to retry an in-flight payment id on the consumed task', async () => {
    const inFlight = new CommerceError('PAYMENT_REPLAYED', 'A request is in progress', {
      httpStatus: 409,
      retryable: true,
      requestId: 'req-1',
      resourceId: 'report',
      details: { reason: 'payment_identifier_in_flight', retryAfterSeconds: 1, extra: 'kept' },
    });

    const { task, envelope, pendingPayments } = await resumeWith(inFlight);

    expect(task.status.state).toBe('TASK_STATE_FAILED');
    expect(envelope).toEqual({
      status: 'error',
      code: 'PAYMENT_REPLAYED',
      message: 'A request is in progress',
      retryable: false,
      requestId: 'req-1',
      resourceId: 'report',
      details: { reason: 'payment_identifier_in_flight', extra: 'kept' },
    });
    expect(task.status.message?.metadata).toMatchObject({
      'x402.payment.status': 'payment-failed',
      'x402.payment.error': 'payment_identifier_in_flight',
    });
    // The consumed task cannot accept another submission
    expect(await pendingPayments.get('task-1')).toBeUndefined();
  });

  it('keeps the retryable flag of every other refusal', async () => {
    const unresolved = new CommerceError('PAYMENT_REPLAYED', 'Unresolved', {
      httpStatus: 409,
      details: { reason: 'payment_identifier_unresolved' },
    });
    const backend = new CommerceError('BACKEND_TIMEOUT', 'Timed out', { retryable: true });

    expect((await resumeWith(unresolved)).envelope.retryable).toBe(false);
    expect((await resumeWith(backend)).envelope.retryable).toBe(true);
  });
});
