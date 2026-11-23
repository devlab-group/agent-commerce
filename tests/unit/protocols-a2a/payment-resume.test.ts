// Pipeline refusals after a payment follow-up consumes the task
import { describe, expect, it, vi } from 'vitest';
import {
  type Clock,
  CommerceError,
  type Logger,
  type ProtocolAdapterContext,
} from '../../../src/core';
import { createBackgroundRuns } from '../../../src/protocols/a2a/background';
import { resumePayment } from '../../../src/protocols/a2a/payment-resume';
import type { A2aTask } from '../../../src/protocols/a2a/types';
import {
  createPendingPayments,
  type PendingPayments,
} from '../../../src/protocols/a2a/x402-extension';

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

  const response = await resumePayment(
    {
      context,
      pendingPayments,
      keep: async () => true,
      running: new Set(),
      background: createBackgroundRuns(1, logger),
      recordWorking: async () => undefined,
    },
    1,
    { message },
    false,
  );
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

describe('resumePayment failure text', () => {
  const settled = {
    payment: { status: 'settled', provider: 'x402', currency: 'USDC', externalReference: '0xabc' },
  };

  it.each([
    [
      'a refused payment, with its x402 error code',
      new CommerceError('PAYMENT_INVALID', 'Refused', {
        details: { reason: 'insufficient_funds' },
      }),
      'Payment failed: insufficient_funds.',
    ],
    [
      'a replayed EVM proof, with the nonce code',
      new CommerceError('PAYMENT_REPLAYED', 'Used', { details: { network: 'eip155:8453' } }),
      'Payment failed: invalid_exact_evm_nonce_already_used.',
    ],
    [
      'a failure before settlement, with its commerce code',
      new CommerceError('BACKEND_TIMEOUT', 'Timed out'),
      'The resource could not be delivered: backend_timeout.',
    ],
    [
      'a retry-key refusal, with its own message',
      new CommerceError('PAYMENT_REPLAYED', 'A request is in progress', {
        details: { reason: 'payment_identifier_in_flight' },
      }),
      'A request is in progress',
    ],
    [
      'a backend failure after settlement, as a settled payment',
      new CommerceError('BACKEND_ERROR', 'Backend failed', { details: settled }),
      'Payment settled, but the resource could not be delivered.',
    ],
  ])('states %s', async (_label, refusal, text) => {
    const { task } = await resumeWith(refusal);

    expect(task.status.message?.parts).toEqual([{ text }]);
  });
});

describe('resumePayment with returnImmediately', () => {
  // Use one slot to check that refused calls release their reservations
  async function answer(
    status: string,
    pendingPayments: PendingPayments,
    recordWorking: () => Promise<CommerceError | undefined> = async () => undefined,
  ) {
    const background = createBackgroundRuns(1, logger);
    const context = {
      pipeline: { execute: vi.fn() },
      logger,
      clock,
      ids: { next: (prefix = 'id') => `${prefix}-1` },
    } as unknown as ProtocolAdapterContext;
    const message = {
      taskId: 'task-1',
      messageId: 'msg-1',
      role: 'ROLE_USER',
      metadata: { 'x402.payment.status': status, 'x402.payment.payload': { scheme: 'exact' } },
    };
    const response = await resumePayment(
      {
        context,
        pendingPayments,
        keep: async () => true,
        running: new Set(),
        background,
        recordWorking,
      },
      1,
      { message },
      true,
    );
    return { response, background, execute: context.pipeline.execute };
  }

  it('frees the slot when another call took the task first', async () => {
    const pendingPayments = createPendingPayments(clock);
    await pendingPayments.put('task-1', { contextId: 'ctx-1', resourceId: 'report', input: {} });
    // Simulate another call taking the task between the read and the take
    const lost: PendingPayments = { ...pendingPayments, take: async () => undefined };

    const { response, background, execute } = await answer('payment-submitted', lost);

    expect(response).toBeUndefined();
    expect(background.reserve()).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('frees the slot and runs nothing when the working task cannot be recorded', async () => {
    const pendingPayments = createPendingPayments(clock);
    await pendingPayments.put('task-1', { contextId: 'ctx-1', resourceId: 'report', input: {} });

    const { response, background, execute } = await answer(
      'payment-submitted',
      pendingPayments,
      async () => new CommerceError('STORAGE_ERROR', 'The task store is unavailable.'),
    );

    const task = (response as { result: { task: A2aTask } }).result.task;
    expect(task.status.state).toBe('TASK_STATE_FAILED');
    expect(task.artifacts[0]?.parts[0]?.data).toMatchObject({ code: 'STORAGE_ERROR' });
    expect(background.reserve()).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('declines at once without taking a slot', async () => {
    const pendingPayments = createPendingPayments(clock);
    await pendingPayments.put('task-1', { contextId: 'ctx-1', resourceId: 'report', input: {} });

    const { response, background } = await answer('payment-rejected', pendingPayments);

    const task = (response as { result: { task: A2aTask } }).result.task;
    expect(task.status.state).toBe('TASK_STATE_FAILED');
    expect(background.reserve()).toBe(true);
  });
});
