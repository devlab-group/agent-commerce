/**
 * The paid flow, driven by the official SDK: challenge, pay, retry, delivery.
 *
 * The assertion that matters throughout is the merchant backend call count.
 * "Payment succeeded" in a response body proves nothing — a paywall works if
 * and only if the backend is not called before a valid proof and is called
 * exactly once after one.
 *
 * Verification and settlement belong to the payment provider; every case below
 * is arranged so that the A2A adapter deciding anything about a proof would
 * make the test fail.
 */
import { Role, type SendMessageRequest, TaskState } from '@a2a-js/sdk';
import { type Client, ClientFactory } from '@a2a-js/sdk/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PAYMENT_INPUT_FIELD } from '../../../src/core/index.js';
import {
  MERCHANT_BODY,
  type RunningGateway,
  startConformanceGateway,
  VALID_PROOF,
} from './support/gateway.js';

let running: RunningGateway;
let client: Client;

beforeEach(async () => {
  running = await startConformanceGateway();
  client = await new ClientFactory().createFromUrl(running.url);
});

afterEach(async () => {
  await running?.close();
});

function buy(input: Record<string, unknown>): SendMessageRequest {
  return {
    tenant: '',
    message: {
      messageId: 'msg-paid-1',
      contextId: '',
      taskId: '',
      role: Role.ROLE_USER,
      parts: [
        {
          content: { $case: 'data', value: { resource: 'market_report', input } },
          mediaType: 'application/json',
          filename: '',
          metadata: undefined,
        },
      ],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: undefined,
  };
}

/** Narrows `Task | Message` and returns the single artifact payload. */
async function send(input: Record<string, unknown>) {
  const result = await client.sendMessage(buy(input));
  if (!('status' in result)) throw new Error('expected a task, got a message');
  const data = result.artifacts[0]?.parts[0]?.content;
  return {
    state: result.status?.state,
    data: (data?.$case === 'data' ? data.value : undefined) as Record<string, unknown> | undefined,
  };
}

describe('paid resource over A2A', () => {
  it('challenges an unpaid call with the canonical payment-required envelope', async () => {
    const { state, data } = await send({ symbol: 'ETH' });

    expect(state).toBe(TaskState.TASK_STATE_FAILED);
    // The existing Agent Commerce envelope, not an A2A-specific schema.
    expect(data?.['status']).toBe('payment-required');
    expect(data?.['code']).toBe('PAYMENT_REQUIRED');
    expect(data?.['payment']).toMatchObject({
      provider: 'x402',
      amount: '0.01',
      currency: 'USDC',
      destination: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    });
    expect(running.backendCalls()).toBe(0);
  });

  it('delivers exactly once when the retry carries a valid proof', async () => {
    const challenge = await send({ symbol: 'ETH' });
    expect(challenge.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(running.backendCalls()).toBe(0);

    const delivery = await send({ symbol: 'ETH', [PAYMENT_INPUT_FIELD]: VALID_PROOF });

    expect(delivery.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(delivery.data).toEqual(MERCHANT_BODY);
    expect(running.backendCalls()).toBe(1);
    expect(running.settleCalls()).toBe(1);
  });

  it('reports the settled payment in the delivery summary', async () => {
    const result = await client.sendMessage(
      buy({ symbol: 'ETH', [PAYMENT_INPUT_FIELD]: VALID_PROOF }),
    );
    if (!('status' in result)) throw new Error('expected a task');

    const metadata = result.artifacts[0]?.metadata as Record<string, unknown> | undefined;
    const summary = metadata?.['agent-commerce/delivery'] as Record<string, unknown> | undefined;
    expect(summary).toMatchObject({ resourceId: 'market_report' });
    expect(JSON.stringify(summary)).toContain('0xTXHASH');
  });

  it.each([
    ['no proof at all', {}],
    ['an empty proof', { [PAYMENT_INPUT_FIELD]: '' }],
    ['a malformed proof', { [PAYMENT_INPUT_FIELD]: { not: 'a string' } }],
    ['an invalid proof', { [PAYMENT_INPUT_FIELD]: 'forged-proof' }],
    ['an unverifiable proof', { [PAYMENT_INPUT_FIELD]: 'unverifiable-proof' }],
  ])('delivers nothing for %s', async (_label, payment) => {
    const { state } = await send({ symbol: 'ETH', ...payment });

    expect(state).toBe(TaskState.TASK_STATE_FAILED);
    expect(running.backendCalls()).toBe(0);
    expect(running.settleCalls()).toBe(0);
  });

  it('never settles a proof the provider rejected', async () => {
    await send({ symbol: 'ETH', [PAYMENT_INPUT_FIELD]: 'forged-proof' });
    expect(running.settleCalls()).toBe(0);

    // …and a good proof afterwards still works: one bad attempt does not
    // poison the resource.
    const delivery = await send({ symbol: 'ETH', [PAYMENT_INPUT_FIELD]: VALID_PROOF });
    expect(delivery.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(running.backendCalls()).toBe(1);
  });

  it('advertises the paid resource as a skill tagged paid, with its price', async () => {
    const card = await (await fetch(`${running.url}/.well-known/agent-card.json`)).json();
    const skill = (
      card as { skills: { id: string; tags: string[]; description: string }[] }
    ).skills.find((s) => s.id === 'market_report');

    expect(skill?.tags).toContain('paid');
    expect(skill?.description).toContain('0.01 USDC');
  });
});
