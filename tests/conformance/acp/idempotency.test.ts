/**
 * Idempotency on `completeCheckoutSession`, measured at the merchant.
 *
 * This is the case that matters: completion is the destructive one, and the
 * only assertion that proves anything is the merchant's call count. A gateway
 * that answers a retry correctly while placing a second order has failed, and
 * nothing but counting calls on the far side can tell.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AcpStack,
  acpFetch,
  acpHeaders,
  COMPLETE_REQUEST,
  CREATE_REQUEST,
  startAcpStack,
} from './support/gateway.js';

let stack: AcpStack;

beforeEach(async () => {
  stack = await startAcpStack();
});

afterEach(async () => {
  await stack.close();
});

const COMPLETE_PATH = '/acp/checkout_sessions/cs_abc123/complete';

function complete(key: string, body: unknown = COMPLETE_REQUEST) {
  return acpFetch(stack, COMPLETE_PATH, { headers: acpHeaders({ 'idempotency-key': key }), body });
}

describe('completion replay', () => {
  it('runs the merchant once and replays the stored answer for the retry', async () => {
    const first = await complete('idem-complete-1');
    const second = await complete('idem-complete-1');

    expect(first.status).toBe(200);
    expect(first.headers.get('idempotent-replayed')).toBeNull();

    expect(second.status).toBe(200);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(second.headers.get('idempotency-key')).toBe('idem-complete-1');
    expect(second.body).toEqual(first.body);

    // The order was placed once.
    expect(stack.calls).toHaveLength(1);
  });

  it('refuses a key reused for a different body, and still runs the merchant once', async () => {
    await complete('idem-complete-2');
    const conflict = await complete('idem-complete-2', {
      ...COMPLETE_REQUEST,
      buyer: { first_name: 'Someone', last_name: 'Else', email: 'else@example.com' },
    });

    expect(conflict.status).toBe(422);
    expect(conflict.body['code']).toBe('idempotency_conflict');
    expect(stack.calls).toHaveLength(1);
  });

  // Same request, differently serialised: a retry through another JSON encoder
  // is a retry, not a conflict.
  it('treats a reordered body as the same request', async () => {
    const reordered = Object.fromEntries(Object.entries(COMPLETE_REQUEST).reverse());
    await complete('idem-complete-3');
    const retry = await complete('idem-complete-3', reordered);

    expect(retry.status).toBe(200);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    expect(stack.calls).toHaveLength(1);
  });

  it('answers 409 while the first request is still in flight', async () => {
    // The merchant holds the first completion open; the duplicate arrives
    // while the claim is live.
    stack.nextReply({ status: 200, body: {}, delayMs: 300 });
    const inFlight = complete('idem-complete-4');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const duplicate = await complete('idem-complete-4');
    await inFlight;

    expect(duplicate.status).toBe(409);
    expect(duplicate.body['code']).toBe('idempotency_in_flight');
    expect(duplicate.headers.get('retry-after')).toBe('1');
    expect(stack.calls).toHaveLength(1);
  });

  it('does not cache a 5xx, so a clean retry reaches the merchant again', async () => {
    stack.nextReply({ status: 500, body: { error: 'merchant exploded' } });
    const failed = await complete('idem-complete-5');
    const retry = await complete('idem-complete-5');

    expect(failed.status).toBe(502);
    expect(retry.status).toBe(200);
    expect(retry.headers.get('idempotent-replayed')).toBeNull();
    expect(stack.calls).toHaveLength(2);
  });

  it('scopes a key to its endpoint, so the same key may create and complete', async () => {
    await acpFetch(stack, '/acp/checkout_sessions', {
      headers: acpHeaders({ 'idempotency-key': 'shared-key' }),
      body: CREATE_REQUEST,
    });
    const completed = await complete('shared-key');

    expect(completed.status).toBe(200);
    expect(completed.headers.get('idempotent-replayed')).toBeNull();
    expect(stack.calls).toHaveLength(2);
  });
});
