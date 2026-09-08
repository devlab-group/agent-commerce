/**
 * What leaves the ACP adapter.
 *
 * Two questions, asked of every case: does the caller get a protocol-valid ACP
 * document on the status ACP fixes for that route, and does anything internal -
 * a merchant body, a stack, a database string, a backend URL - come with it.
 */
import { describe, expect, it } from 'vitest';
import { CommerceError, type CommerceErrorCode } from '../../../src/core/index.js';
import { createAcpAdapter } from '../../../src/protocols/acp/adapter.js';
import { ACP_SPEC_VERSION } from '../../../src/protocols/acp/constants.js';
import { validateAcpDocument } from '../../../src/protocols/acp/validation.js';
import {
  ACP_EXAMPLES,
  adapterOptions,
  delivered,
  deliveredFor,
  MOUNT,
  sessionDocument,
  setup,
  TOKEN,
} from './fixtures.js';

interface Sent {
  status: number;
  body: Record<string, unknown>;
}

const CREATE_BODY = { line_items: [{ id: 'item_123' }], currency: 'usd', capabilities: {} };

async function send(
  context: Parameters<ReturnType<typeof createAcpAdapter>['start']>[0],
  request: { method?: string; url?: string; body?: unknown },
): Promise<Sent> {
  const adapter = createAcpAdapter(adapterOptions());
  await adapter.start(context);

  let status = 0;
  let raw = '';
  const res = {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(chunk?: string) {
      raw = chunk ?? '';
      return res;
    },
  };
  const payload = request.body === undefined ? undefined : JSON.stringify(request.body);
  const req = Object.assign(
    (async function* () {
      if (payload !== undefined) yield Buffer.from(payload, 'utf8');
    })(),
    {
      method: request.method ?? 'POST',
      url: request.url ?? `${MOUNT}/checkout_sessions`,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'api-version': ACP_SPEC_VERSION,
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
        'idempotency-key': 'idem-1',
      },
    },
  );
  await adapter.handleHttp(req as never, res as never);
  await adapter.stop();
  return { status, body: raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {} };
}

describe('ACP success responses', () => {
  it('answers 201 on create', async () => {
    const { context } = setup(deliveredFor('createCheckoutSession'));
    const result = await send(context, { body: CREATE_BODY });

    expect(result.status).toBe(201);
    expect(validateAcpDocument('checkoutSession', result.body)).toBeUndefined();
  });

  it.each([
    ['update', 'POST', `${MOUNT}/checkout_sessions/cs_9`, 'updateCheckoutSession'],
    ['retrieve', 'GET', `${MOUNT}/checkout_sessions/cs_9`, 'getCheckoutSession'],
    ['cancel', 'POST', `${MOUNT}/checkout_sessions/cs_9/cancel`, 'cancelCheckoutSession'],
  ] as const)('answers 200 on %s', async (_label, method, url, operation) => {
    const { context } = setup(deliveredFor(operation));
    const result = await send(context, {
      method,
      url,
      ...(method === 'POST' ? { body: {} } : {}),
    });

    expect(result.status).toBe(200);
    expect(validateAcpDocument('checkoutSession', result.body)).toBeUndefined();
  });

  it('answers 200 on complete, with the order the snapshot requires', async () => {
    const { context } = setup(deliveredFor('completeCheckoutSession'));
    const result = await send(context, {
      url: `${MOUNT}/checkout_sessions/cs_9/complete`,
      body: ACP_EXAMPLES['complete_checkout_session_request'],
    });

    expect(result.status).toBe(200);
    expect(validateAcpDocument('checkoutSessionWithOrder', result.body)).toBeUndefined();
    expect((result.body['order'] as { id?: string }).id).toBeDefined();
  });

  // A completion that ends in a declined payment is a legitimate 200 with an
  // ordinary session and no order - both are examples in the snapshot - so the
  // session's own status decides which contract applies.
  it('accepts a completion that did not complete, and requires no order for it', async () => {
    const { context } = setup(
      delivered(ACP_EXAMPLES['checkout_session_with_payment_declined'], 200),
    );
    const result = await send(context, {
      url: `${MOUNT}/checkout_sessions/cs_9/complete`,
      body: ACP_EXAMPLES['complete_checkout_session_request'],
    });

    expect(result.status).toBe(200);
    expect(result.body['order']).toBeUndefined();
  });

  it('refuses a completed session that carries no order', async () => {
    const { context } = setup(delivered(sessionDocument({ status: 'completed' }), 200));
    const result = await send(context, {
      url: `${MOUNT}/checkout_sessions/cs_9/complete`,
      body: ACP_EXAMPLES['complete_checkout_session_request'],
    });

    expect(result.status).toBe(500);
    expect(result.body['type']).toBe('processing_error');
  });
});

describe('ACP refuses a non-conformant merchant answer', () => {
  // Silently renumbering a merchant 200 to ACP's 201 would publish a backend
  // that has not implemented the operation as if it had.
  it('fails safely when create succeeds with the wrong status', async () => {
    const { context } = setup(delivered(sessionDocument(), 200));
    const result = await send(context, { body: CREATE_BODY });

    expect(result.status).toBe(500);
    expect(result.body['type']).toBe('processing_error');
    expect(validateAcpDocument('error', result.body)).toBeUndefined();
  });

  it('never forwards a body that is not an ACP checkout session', async () => {
    const { context } = setup(
      delivered(
        { ok: true, internal_note: 'orders-db row 42', debug_url: 'http://10.0.0.4/x' },
        201,
      ),
    );
    const result = await send(context, { body: CREATE_BODY });

    expect(result.status).toBe(500);
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain('internal_note');
    expect(serialized).not.toContain('10.0.0.4');
  });
});

describe('ACP error mapping', () => {
  function failing(code: CommerceErrorCode, details?: Record<string, unknown>) {
    return setup(
      new CommerceError(code, 'internal detail: postgres://user:pw@db/orders', {
        ...(details !== undefined ? { details } : {}),
      }),
    );
  }

  it.each([
    ['a backend 404', 'BACKEND_ERROR', { status: 404 }, 404, 'checkout_session_not_found'],
    ['a backend 422', 'BACKEND_ERROR', { status: 422 }, 422, 'invalid_request_body'],
    ['a backend 409', 'BACKEND_ERROR', { status: 409 }, 409, 'checkout_session_conflict'],
    ['a backend 500', 'BACKEND_ERROR', { status: 500 }, 502, 'processing_error'],
    // Relaying it would tell the agent its own bearer token failed.
    ['a backend 401', 'BACKEND_ERROR', { status: 401 }, 502, 'processing_error'],
    ['a timeout', 'BACKEND_TIMEOUT', undefined, 504, 'service_unavailable'],
    ['invalid input', 'INPUT_INVALID', undefined, 400, 'invalid_request_body'],
    ['a broken mapping', 'RESOURCE_NOT_FOUND', undefined, 500, 'processing_error'],
    ['a storage failure', 'STORAGE_ERROR', undefined, 500, 'processing_error'],
    ['load shedding', 'GATEWAY_BUSY', undefined, 503, 'service_unavailable'],
    // A checkout resource can only be paid through a configuration mistake.
    ['a payment failure', 'PAYMENT_INVALID', undefined, 500, 'processing_error'],
  ] as const)('maps %s', async (_label, code, details, status, expectedCode) => {
    const { context } = failing(code, details as Record<string, unknown> | undefined);
    const result = await send(context, { body: CREATE_BODY });

    expect(result.status).toBe(status);
    expect(result.body['code']).toBe(expectedCode);
    expect(validateAcpDocument('error', result.body)).toBeUndefined();
  });

  it('maps a merchant 405 on cancel to a cancel-specific refusal', async () => {
    const { context } = failing('BACKEND_ERROR', { status: 405 });
    const result = await send(context, {
      url: `${MOUNT}/checkout_sessions/cs_9/cancel`,
      body: {},
    });

    expect(result.status).toBe(405);
    expect(result.body['code']).toBe('checkout_session_not_cancelable');
  });

  it('leaks neither the merchant body nor a stack in any mapped error', async () => {
    const codes: readonly CommerceErrorCode[] = [
      'BACKEND_ERROR',
      'BACKEND_TIMEOUT',
      'STORAGE_ERROR',
      'INPUT_INVALID',
    ];
    for (const code of codes) {
      const { context } = failing(code, { status: 500, body: 'SECRET-BODY' });
      const result = await send(context, { body: CREATE_BODY });
      const serialized = JSON.stringify(result.body);

      expect(serialized).not.toContain('postgres');
      expect(serialized).not.toContain('SECRET-BODY');
      expect(serialized).not.toContain('at Object.');
      expect(Object.keys(result.body).sort()).toEqual(['code', 'message', 'type']);
    }
  });
});
