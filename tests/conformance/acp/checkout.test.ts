/**
 * The five stable checkout operations, end to end.
 *
 * Requests are the snapshot's own example documents, sent over a socket to a
 * real gateway; answers are the snapshot's own example responses, sent by a
 * real merchant server. What is asserted in between is the request that
 * actually reached the merchant - method, path and body - because the canonical
 * envelope reaching the backend correctly is the part no unit test can see.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateAcpDocument } from '../../../src/protocols/acp/validation.js';
import {
  ACP_EXAMPLES,
  ACP_OPERATIONS,
  type AcpStack,
  acpFetch,
  acpHeaders,
  COMPLETE_REQUEST,
  CREATE_REQUEST,
  startAcpStack,
  UPDATE_REQUEST,
} from './support/gateway.js';

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

    expect(stack.calls).toEqual([
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
    expect(stack.calls[0]).toEqual({
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
    expect(stack.calls[0]).toEqual({
      method: 'GET',
      path: '/checkout_sessions/cs_abc123',
      query: {},
      body: undefined,
    });
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

  // The merchant's own purchase payment, on its way through as business input.
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
    expect(stack.calls[0]).toEqual({
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
  it('never calls the merchant twice for a single accepted request', async () => {
    await acpFetch(stack, '/acp/checkout_sessions', { body: CREATE_REQUEST });
    expect(stack.calls).toHaveLength(1);
  });

  it('routes each operation to its own configured resource', async () => {
    await acpFetch(stack, '/acp/checkout_sessions', { body: CREATE_REQUEST });
    await acpFetch(stack, '/acp/checkout_sessions/cs_1', { method: 'GET' });
    await acpFetch(stack, '/acp/checkout_sessions/cs_1/cancel', { body: {} });

    expect(stack.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /checkout_sessions',
      'GET /checkout_sessions/cs_1',
      'POST /checkout_sessions/cs_1/cancel',
    ]);
    expect(Object.values(ACP_OPERATIONS)).toHaveLength(5);
  });
});
