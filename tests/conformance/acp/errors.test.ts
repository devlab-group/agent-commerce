/**
 * What a failing merchant looks like from the client side.
 *
 * The merchant here answers badly on purpose - wrong status, wrong shape, too
 * slow, or with an internal detail in the body - and every case asserts the
 * same two things: the client gets a valid ACP error, and nothing of the
 * merchant's answer travels with it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { validateAcpDocument } from '../../../src/protocols/acp/validation';
import {
  ACP_EXAMPLES,
  ACP_TOKEN,
  type AcpStack,
  acpFetch,
  acpHeaders,
  COMPLETE_REQUEST,
  CREATE_REQUEST,
  startAcpStack,
} from './support/gateway';

let stack: AcpStack | undefined;

afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

// Everything a merchant might put in a failure body that must never travel
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
  // Accept the optional `param` field, but no other response fields
  const keys = 'param' in body ? ['code', 'message', 'param', 'type'] : ['code', 'message', 'type'];
  expect(Object.keys(body).sort()).toEqual(keys);
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
    // Relaying this would tell the agent its own bearer token failed
    ['a 401', 401, 502, 'processing_error'],
  ])('maps %s to an ACP error that carries nothing of it', async (_label, from, to, code) => {
    const result = await createWith({ status: from, body: LEAKY_BODY });

    expect(result.status).toBe(to);
    expect(result.body['code']).toBe(code);
    expect(validateAcpDocument('error', result.body)).toBeUndefined();
    assertNothingLeaked(result.body);
  });

  it('uses a merchant ACP error type, code and param without forwarding its message', async () => {
    const result = await createWith({
      status: 400,
      body: {
        type: 'invalid_request',
        code: 'requires_3ds',
        // Merchant free text must not become the gateway's error message
        message: LEAKY_BODY.error,
        param: '$.authentication_result',
      },
    });

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({
      type: 'invalid_request',
      code: 'requires_3ds',
      param: '$.authentication_result',
    });
    expect(validateAcpDocument('error', result.body)).toBeUndefined();
    assertNothingLeaked(result.body);
  });

  it.each([
    ['an invalid code', { code: 'Requires 3DS!' }],
    ['a non-ACP error body', { code: 'requires_3ds', extra: true }],
  ])('uses gateway error mapping for %s', async (_label, patch) => {
    const result = await createWith({
      status: 400,
      body: { type: 'invalid_request', message: 'm', ...patch },
    });

    expect(result.status).toBe(422);
    expect(result.body['code']).toBe('invalid_request_body');
  });

  it('uses gateway error mapping for an unrelayed merchant status', async () => {
    const result = await createWith({
      status: 500,
      body: { type: 'processing_error', code: 'database_down', message: LEAKY_BODY.error },
    });

    expect(result.status).toBe(502);
    expect(result.body['code']).toBe('processing_error');
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

  it.each([
    ['a tag', 'Ships <b>today</b>', 500],
    ['an HTML comment', 'Ships today<!-- internal -->', 500],
    ['a tag inside a code span, which is text', 'Use the `<b>` element', 201],
    ['an autolink, which is not HTML', 'See <https://shop.example/terms>', 201],
  ])('%s in merchant markdown', async (_label, content, status) => {
    const result = await createWith({
      status: 201,
      body: {
        ...ACP_EXAMPLES['create_checkout_session_response'],
        messages: [{ type: 'info', content_type: 'markdown', content }],
      },
    });

    // Reject tags and comments; retain code spans and autolinks as text
    expect(result.status).toBe(status);
  });

  // Relabeling the merchant's status as the one ACP expects would present a
  // backend that has not implemented the operation as if it had
  it('refuses a merchant that succeeds on the wrong status', async () => {
    stack = await startAcpStack();
    // A conformant session, so only the status can be the reason for refusing it
    stack.nextReply({ status: 200, body: ACP_EXAMPLES['create_checkout_session_response'] });
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

  it('refuses a retry after a merchant 5xx instead of running the operation twice', async () => {
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
    // A merchant 500 does not prove the merchant did nothing: it may have
    // recorded the order and failed afterwards, so a re-run could order twice
    expect(retry.status).toBe(409);
    expect(retry.body['code']).toBe('idempotency_unresolved');
    // No Retry-After: waiting does not resolve this, the merchant's records do
    expect(retry.headers.get('retry-after')).toBeNull();
    expect(stack.calls).toHaveLength(1);
  });
});
