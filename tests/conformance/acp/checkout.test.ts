/**
 * The five stable checkout operations, end to end.
 *
 * Requests are the snapshot's own example documents, sent over a socket to a
 * real gateway; answers are the snapshot's own example responses, sent by a
 * real merchant server. The assertions are on the request that reached the
 * merchant (method, path and body), the part no unit test can see.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateAcpDocument } from '../../../src/protocols/acp/validation';
import {
  ACP_EXAMPLES,
  type AcpStack,
  acpFetch,
  acpHeaders,
  COMPLETE_REQUEST,
  CREATE_REQUEST,
  startAcpStack,
  UPDATE_REQUEST,
} from './support/gateway';

let stack: AcpStack;

beforeEach(async () => {
  stack = await startAcpStack();
});

afterEach(async () => {
  await stack.close();
});

describe('createCheckoutSession', () => {
  it('answers 201 with a checkout session, and posts the request document to the merchant', async () => {
    const result = await acpFetch(stack, '/acp/checkout_sessions', { body: CREATE_REQUEST });

    expect(result.status).toBe(201);
    expect(validateAcpDocument('checkoutSession', result.body)).toBeUndefined();
    expect(result.headers.get('content-type')).toContain('application/json');

    expect(stack.calls).toMatchObject([
      {
        method: 'POST',
        path: '/checkout_sessions',
        query: {},
        body: CREATE_REQUEST,
      },
    ]);
  });
});

describe('updateCheckoutSession', () => {
  it('answers 200 and puts the session id in the merchant path', async () => {
    const result = await acpFetch(stack, '/acp/checkout_sessions/cs_abc123', {
      body: UPDATE_REQUEST,
    });

    expect(result.status).toBe(200);
    expect(validateAcpDocument('checkoutSession', result.body)).toBeUndefined();
    expect(stack.calls[0]).toMatchObject({
      method: 'POST',
      path: '/checkout_sessions/cs_abc123',
      query: {},
      body: UPDATE_REQUEST,
    });
  });
});

describe('getCheckoutSession', () => {
  it('answers 200 and reaches the merchant with GET and no body', async () => {
    const result = await acpFetch(stack, '/acp/checkout_sessions/cs_abc123', {
      method: 'GET',
      headers: acpHeaders({ 'content-type': '' }),
    });

    expect(result.status).toBe(200);
    expect(validateAcpDocument('checkoutSession', result.body)).toBeUndefined();
    expect(stack.calls[0]).toMatchObject({
      method: 'GET',
      path: '/checkout_sessions/cs_abc123',
      query: {},
      body: undefined,
    });
  });

  it('forwards an encoded merchant session id as one path segment', async () => {
    const id = encodeURIComponent('gid://shop/Checkout/1');
    const result = await acpFetch(stack, `/acp/checkout_sessions/${id}`, {
      method: 'GET',
      headers: acpHeaders({ 'content-type': '' }),
    });

    expect(result.status).toBe(200);
    expect(stack.calls[0]?.path).toBe(`/checkout_sessions/${id}`);
  });
});

describe('completeCheckoutSession', () => {
  it('answers 200 with a session carrying its order', async () => {
    const result = await acpFetch(stack, '/acp/checkout_sessions/cs_abc123/complete', {
      body: COMPLETE_REQUEST,
    });

    expect(result.status).toBe(200);
    expect(validateAcpDocument('checkoutSessionWithOrder', result.body)).toBeUndefined();
    expect(result.body['status']).toBe('completed');
    expect((result.body['order'] as { id?: string }).id).toBeDefined();
  });

  // The merchant's own purchase payment, passed through as business input
  it('delivers payment_data to the merchant unchanged', async () => {
    await acpFetch(stack, '/acp/checkout_sessions/cs_abc123/complete', { body: COMPLETE_REQUEST });

    const call = stack.calls[0];
    expect(call?.path).toBe('/checkout_sessions/cs_abc123/complete');
    const body = (call?.body ?? {}) as Record<string, unknown>;
    expect(body['payment_data']).toEqual(COMPLETE_REQUEST['payment_data']);
  });
});

describe('cancelCheckoutSession', () => {
  it('answers 200 for a cancel with no body, and sends the merchant no body either', async () => {
    const headers = acpHeaders();
    delete headers['content-type'];
    const result = await acpFetch(stack, '/acp/checkout_sessions/cs_abc123/cancel', { headers });

    expect(result.status).toBe(200);
    expect(validateAcpDocument('checkoutSession', result.body)).toBeUndefined();
    expect(result.body['status']).toBe('canceled');
    expect(stack.calls[0]).toMatchObject({
      method: 'POST',
      path: '/checkout_sessions/cs_abc123/cancel',
      query: {},
      body: undefined,
    });
  });

  it('forwards an intent_trace when the caller sends one', async () => {
    const body = ACP_EXAMPLES['cancel_checkout_session_request'];
    await acpFetch(stack, '/acp/checkout_sessions/cs_abc123/cancel', { body });

    expect(stack.calls[0]?.body).toEqual(body);
  });
});

describe('one request, one merchant call', () => {
  it('routes each operation to its own configured resource', async () => {
    await acpFetch(stack, '/acp/checkout_sessions', { body: CREATE_REQUEST });
    await acpFetch(stack, '/acp/checkout_sessions/cs_1', { method: 'GET' });
    await acpFetch(stack, '/acp/checkout_sessions/cs_1/cancel', { body: {} });

    expect(stack.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /checkout_sessions',
      'GET /checkout_sessions/cs_1',
      'POST /checkout_sessions/cs_1/cancel',
    ]);
  });
});
