/**
 * What a failing merchant looks like from the client side.
 *
 * The merchant here answers badly on purpose - wrong status, wrong shape, too
 * slow, or with an internal detail in the body - and every case asserts the
 * same two things: the client gets a valid ACP error, and nothing of the
 * merchant's answer travels with it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { validateAcpDocument } from '../../../src/protocols/acp/validation.js';
import {
  ACP_TOKEN,
  type AcpStack,
  acpFetch,
  acpHeaders,
  COMPLETE_REQUEST,
  CREATE_REQUEST,
  startAcpStack,
} from './support/gateway.js';

let stack: AcpStack | undefined;

afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

/** Everything a merchant might put in a failure body that must never travel. */
const LEAKY_BODY = {
  error: 'ECONNREFUSED postgres://checkout:hunter2@10.0.0.7:5432/orders',
  stack: 'at OrderService.create (/srv/merchant/src/orders.ts:88:11)',
  internal_url: 'http://orders.internal.svc.cluster.local/v1/orders',
};

function assertNothingLeaked(body: Record<string, unknown>): void {
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain('postgres');
  expect(serialized).not.toContain('hunter2');
  expect(serialized).not.toContain('10.0.0.7');
  expect(serialized).not.toContain('/srv/merchant');
  expect(serialized).not.toContain('cluster.local');
  expect(serialized).not.toContain(ACP_TOKEN);
  expect(serialized).not.toContain('acp_checkout_');
  // The ACP Error object carries these three fields and nothing else.
  expect(Object.keys(body).sort()).toEqual(['code', 'message', 'type']);
}

async function createWith(reply: {
  status: number;
  body: unknown;
  delayMs?: number;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  stack = await startAcpStack({ backendTimeoutMs: 150 });
  stack.nextReply(reply);
  const result = await acpFetch(stack, '/acp/checkout_sessions', {
    headers: acpHeaders(),
    body: CREATE_REQUEST,
  });
  return { status: result.status, body: result.body };
}

describe('merchant failures', () => {
  it.each([
    ['a 404', 404, 404, 'checkout_session_not_found'],
    ['a 409', 409, 409, 'checkout_session_conflict'],
    ['a 422', 422, 422, 'invalid_request_body'],
    ['a 500', 500, 502, 'processing_error'],
    ['a 503', 503, 502, 'processing_error'],
    // Relaying this would tell the agent its own bearer token failed.
    ['a 401', 401, 502, 'processing_error'],
  ])('maps %s to an ACP error that carries nothing of it', async (_label, from, to, code) => {
    const result = await createWith({ status: from, body: LEAKY_BODY });

    expect(result.status).toBe(to);
    expect(result.body['code']).toBe(code);
    expect(validateAcpDocument('error', result.body)).toBeUndefined();
    assertNothingLeaked(result.body);
  });

  it('maps a merchant that never answers to a service_unavailable', async () => {
    const result = await createWith({ status: 201, body: {}, delayMs: 400 });

    expect(result.status).toBe(504);
    expect(result.body['type']).toBe('service_unavailable');
    expect(validateAcpDocument('error', result.body)).toBeUndefined();
  });

  it('refuses a merchant answer that is not an ACP checkout session', async () => {
    const result = await createWith({
      status: 201,
      body: { ok: true, ...LEAKY_BODY },
    });

    expect(result.status).toBe(500);
    expect(result.body['type']).toBe('processing_error');
    assertNothingLeaked(result.body);
  });

  // Renumbering it would publish a backend that has not implemented the
  // operation as if it had.
  it('refuses a merchant that succeeds on the wrong status', async () => {
    stack = await startAcpStack();
    stack.nextReply({ status: 200, body: {} });
    const result = await acpFetch(stack, '/acp/checkout_sessions', {
      headers: acpHeaders(),
      body: CREATE_REQUEST,
    });

    expect(result.status).toBe(500);
    expect(result.body['type']).toBe('processing_error');
  });

  it('answers 404 for a session the merchant does not know', async () => {
    stack = await startAcpStack();
    stack.nextReply({ status: 404, body: { detail: 'no such row' } });
    const result = await acpFetch(stack, '/acp/checkout_sessions/cs_missing', { method: 'GET' });

    expect(result.status).toBe(404);
    expect(result.body['code']).toBe('checkout_session_not_found');
    expect(JSON.stringify(result.body)).not.toContain('no such row');
  });

  it('answers 405 when the merchant refuses to cancel a session', async () => {
    stack = await startAcpStack();
    stack.nextReply({ status: 405, body: { detail: 'already shipped' } });
    const result = await acpFetch(stack, '/acp/checkout_sessions/cs_abc123/cancel', { body: {} });

    expect(result.status).toBe(405);
    expect(result.body['code']).toBe('checkout_session_not_cancelable');
    expect(JSON.stringify(result.body)).not.toContain('already shipped');
  });

  it('does not store a refused answer, so the same key may be retried', async () => {
    stack = await startAcpStack();
    stack.nextReply({ status: 500, body: LEAKY_BODY });
    const headers = acpHeaders({ 'idempotency-key': 'idem-error-retry' });

    const failed = await acpFetch(stack, '/acp/checkout_sessions/cs_abc123/complete', {
      headers,
      body: COMPLETE_REQUEST,
    });
    const retry = await acpFetch(stack, '/acp/checkout_sessions/cs_abc123/complete', {
      headers,
      body: COMPLETE_REQUEST,
    });

    expect(failed.status).toBe(502);
    expect(retry.status).toBe(200);
    expect(stack.calls).toHaveLength(2);
  });
});
