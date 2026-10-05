/**
 * Idempotency on `completeCheckoutSession`, measured at the merchant.
 *
 * Completion places the order, so these tests count merchant calls: a gateway
 * can answer a retry correctly and still place a second order.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACP_EXAMPLES,
  type AcpStack,
  acpFetch,
  acpHeaders,
  COMPLETE_REQUEST,
  CREATE_REQUEST,
  startAcpStack,
} from './support/gateway';

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

    // The order was placed once
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

  // Same request, serialized differently: a retry through another JSON encoder
  // is a retry, not a conflict
  it('treats a reordered body as the same request', async () => {
    const reordered = Object.fromEntries(Object.entries(COMPLETE_REQUEST).reverse());
    await complete('idem-complete-3');
    const retry = await complete('idem-complete-3', reordered);

    expect(retry.status).toBe(200);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    expect(stack.calls).toHaveLength(1);
  });

  it('answers 409 while the first request is still in flight', async () => {
    // The merchant holds the first completion open until the duplicate has
    // been answered. The claim precedes the merchant call, so once the
    // merchant has the call the claim is live.
    let release = (): void => {};
    stack.nextReply({
      status: 200,
      body: ACP_EXAMPLES['complete_checkout_session_response'],
      until: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    const inFlight = complete('idem-complete-4');
    await vi.waitFor(() => expect(stack.calls).toHaveLength(1));
    const duplicate = await complete('idem-complete-4');
    release();
    const first = await inFlight;

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body['code']).toBe('idempotency_in_flight');
    expect(duplicate.headers.get('retry-after')).toBe('1');
    expect(stack.calls).toHaveLength(1);
  });

  it('holds the key after a merchant 5xx rather than letting a retry order twice', async () => {
    stack.nextReply({ status: 500, body: { error: 'merchant exploded' } });
    const failed = await complete('idem-complete-5');
    const retry = await complete('idem-complete-5');

    expect(failed.status).toBe(502);
    // The merchant was reached and its outcome is unknown, so the answer is
    // neither replayed (we have none to give) nor re-run (it could order twice)
    expect(retry.status).toBe(409);
    expect(retry.body).toMatchObject({ type: 'invalid_request', code: 'idempotency_unresolved' });
    expect(retry.headers.get('idempotent-replayed')).toBeNull();
    expect(stack.calls).toHaveLength(1);
  });

  it('runs a retry with the same key after a merchant 429, which processed nothing', async () => {
    stack.nextReply({ status: 429, body: { error: 'slow down' }, headers: { 'retry-after': '2' } });
    const limited = await complete('idem-complete-429');
    const retry = await complete('idem-complete-429');

    expect(limited.status).toBe(503);
    expect(limited.headers.get('retry-after')).toBe('2');
    expect(retry.status).toBe(200);
    expect(retry.headers.get('idempotent-replayed')).toBeNull();
    expect(stack.calls).toHaveLength(2);
    // The merchant sees one operation name across both attempts
    expect(stack.calls[1]?.headers['idempotency-key']).toBe(
      stack.calls[0]?.headers['idempotency-key'],
    );
  });

  it('holds the key after a merchant 503, which may follow partial work', async () => {
    stack.nextReply({ status: 503, body: { error: 'overloaded' } });
    const failed = await complete('idem-complete-503');
    const retry = await complete('idem-complete-503');

    expect(failed.status).toBe(503);
    expect(failed.body['type']).toBe('service_unavailable');
    expect(failed.headers.get('retry-after')).toBe('5');
    expect(retry.status).toBe(409);
    expect(retry.body['code']).toBe('idempotency_unresolved');
    expect(stack.calls).toHaveLength(1);
  });

  it('replays a completion to a retry that changed only its forwarded headers', async () => {
    const send = (userAgent: string) =>
      acpFetch(stack, COMPLETE_PATH, {
        headers: acpHeaders({
          'idempotency-key': 'idem-complete-headers',
          'user-agent': userAgent,
          timestamp: userAgent === 'agent/1' ? '2026-10-05T10:00:00Z' : '2026-10-05T10:00:09Z',
        }),
        body: COMPLETE_REQUEST,
      });
    const first = await send('agent/1');
    const retry = await send('agent/2');

    expect(first.status).toBe(200);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    expect(stack.calls).toHaveLength(1);
  });

  it('retries after a merchant 503 when merchant idempotency is enabled', async () => {
    const dedup = await startAcpStack({ merchantIdempotent: true });
    try {
      dedup.nextReply({ status: 503, body: { error: 'overloaded' } });
      const headers = acpHeaders({ 'idempotency-key': 'idem-dedup-503' });
      const failed = await acpFetch(dedup, COMPLETE_PATH, { headers, body: COMPLETE_REQUEST });
      const retry = await acpFetch(dedup, COMPLETE_PATH, { headers, body: COMPLETE_REQUEST });

      expect(failed.status).toBe(503);
      expect(retry.status).toBe(200);
      expect(dedup.calls).toHaveLength(2);
    } finally {
      await dedup.close();
    }
  });

  it('retries after a merchant 5xx when merchant idempotency is enabled', async () => {
    const dedup = await startAcpStack({ merchantIdempotent: true });
    try {
      dedup.nextReply({ status: 500, body: { error: 'merchant exploded' } });
      const headers = acpHeaders({ 'idempotency-key': 'idem-dedup-5' });
      const failed = await acpFetch(dedup, COMPLETE_PATH, { headers, body: COMPLETE_REQUEST });
      const retry = await acpFetch(dedup, COMPLETE_PATH, { headers, body: COMPLETE_REQUEST });

      expect(failed.status).toBe(502);
      // The gateway retries with the same derived key; the merchant must
      // deduplicate the operation in this mode
      expect(retry.status).toBe(200);
      expect(dedup.calls).toHaveLength(2);
      expect(dedup.calls[1]?.headers['idempotency-key']).toBe(
        dedup.calls[0]?.headers['idempotency-key'],
      );
    } finally {
      await dedup.close();
    }
  });

  it('places one order when the merchant acts and the answer arrives too late', async () => {
    // The merchant records the order, then answers after our timeout. A timeout
    // does not mean no order was placed, so the retry must not place a second one.
    const slow = await startAcpStack({ backendTimeoutMs: 150 });
    try {
      slow.nextReply({
        status: 200,
        body: ACP_EXAMPLES['complete_checkout_session_response'],
        delayMs: 500,
      });
      const headers = acpHeaders({ 'idempotency-key': 'idem-late-answer' });
      const timedOut = await acpFetch(slow, COMPLETE_PATH, { headers, body: COMPLETE_REQUEST });
      const retry = await acpFetch(slow, COMPLETE_PATH, { headers, body: COMPLETE_REQUEST });

      expect(timedOut.status).toBe(504);
      expect(retry.status).toBe(409);
      expect(retry.body['code']).toBe('idempotency_unresolved');
      expect(slow.calls).toHaveLength(1);
    } finally {
      await slow.close();
    }
  });

  it('gives the merchant one derived key per operation, stable across gateway instances', async () => {
    const headers = acpHeaders({ 'idempotency-key': 'idem-stable' });
    await acpFetch(stack, COMPLETE_PATH, { headers, body: COMPLETE_REQUEST });
    // A second endpoint with the same client key: a merchant keying state on the
    // forwarded value must not see two operations as one
    await acpFetch(stack, '/acp/checkout_sessions', { headers, body: CREATE_REQUEST });
    // Another gateway for the same deployment, with its own idempotency store,
    // runs the same operation: the merchant must be able to recognize it
    const other = await startAcpStack();
    try {
      await acpFetch(other, COMPLETE_PATH, { headers, body: COMPLETE_REQUEST });
    } finally {
      await other.close();
    }

    expect(stack.calls).toHaveLength(2);
    expect(other.calls).toHaveLength(1);
    const [completed, created] = stack.calls;
    const forwarded = completed?.headers['idempotency-key'];
    // A digest of deployment, endpoint and client key, never the caller's own
    // key, which names no operation on its own
    expect(forwarded).toMatch(/^[0-9a-f]{64}$/);
    expect(created?.headers['idempotency-key']).not.toBe(forwarded);
    expect(other.calls[0]?.headers['idempotency-key']).toBe(forwarded);
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
