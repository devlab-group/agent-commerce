/**
 * The ACP adapter against a spied `ExecutionPipeline`: one accepted checkout
 * request must produce exactly one canonical execution, carrying the mapped
 * resource and the deterministic envelope - and nothing the adapter invented.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAYMENT_INPUT_FIELD } from '../../../src/core/index.js';
import { createAcpAdapter } from '../../../src/protocols/acp/adapter.js';
import { ACP_SPEC_VERSION } from '../../../src/protocols/acp/constants.js';
import {
  ACP_OPERATIONS,
  adapterOptions,
  deliveredFor,
  firstRequest,
  MOUNT,
  paymentRequired,
  setup,
  TOKEN,
} from './fixtures.js';

interface Sent {
  status: number;
  body: Record<string, unknown>;
}

async function send(
  context: Parameters<ReturnType<typeof createAcpAdapter>['start']>[0],
  request: { method?: string; url: string; body?: unknown; key?: string },
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
      url: request.url,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'api-version': ACP_SPEC_VERSION,
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
        'idempotency-key': request.key ?? 'idem-1',
      },
    },
  );
  await adapter.handleHttp(req as never, res as never);
  await adapter.stop();
  return { status, body: raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {} };
}

const CREATE_BODY = {
  line_items: [{ id: 'item_123' }],
  currency: 'usd',
  capabilities: {},
};

describe('ACP checkout mapping', () => {
  it('maps create to the configured resource, with the body as the only input', async () => {
    const { context, execute } = setup(deliveredFor('createCheckoutSession'));
    await send(context, { url: `${MOUNT}/checkout_sessions`, body: CREATE_BODY });

    const canonical = firstRequest(execute);
    expect(canonical.resourceId).toBe(ACP_OPERATIONS.createCheckoutSession);
    expect(canonical.protocol).toBe('acp');
    expect(canonical.input).toEqual({ body: CREATE_BODY });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('maps update to path plus body', async () => {
    const { context, execute } = setup(deliveredFor('updateCheckoutSession'));
    await send(context, {
      url: `${MOUNT}/checkout_sessions/cs_9`,
      body: { line_items: [{ id: 'item_1' }] },
    });

    const canonical = firstRequest(execute);
    expect(canonical.resourceId).toBe(ACP_OPERATIONS.updateCheckoutSession);
    expect(canonical.input).toEqual({
      path: { checkout_session_id: 'cs_9' },
      body: { line_items: [{ id: 'item_1' }] },
    });
  });

  it('maps retrieve to the path alone, with no body key at all', async () => {
    const { context, execute } = setup(deliveredFor('getCheckoutSession'));
    await send(context, { method: 'GET', url: `${MOUNT}/checkout_sessions/cs_9` });

    const canonical = firstRequest(execute);
    expect(canonical.resourceId).toBe(ACP_OPERATIONS.getCheckoutSession);
    expect(canonical.input).toEqual({ path: { checkout_session_id: 'cs_9' } });
  });

  // The merchant's own purchase payment. It is business input on its way to the
  // merchant backend, and must not become a gateway payment proof.
  it('carries payment_data through completion as ordinary business input', async () => {
    const { context, execute } = setup(deliveredFor('completeCheckoutSession'));
    const body = {
      payment_data: {
        handler_id: 'handler_1',
        instrument: { type: 'card', credential: { type: 'spt', token: 'spt_123' } },
      },
    };
    await send(context, { url: `${MOUNT}/checkout_sessions/cs_9/complete`, body });

    const canonical = firstRequest(execute);
    expect(canonical.resourceId).toBe(ACP_OPERATIONS.completeCheckoutSession);
    expect(canonical.input).toEqual({ path: { checkout_session_id: 'cs_9' }, body });
    expect(canonical.payment).toBeUndefined();
    expect(JSON.stringify(canonical.input)).not.toContain(PAYMENT_INPUT_FIELD);
  });

  it('maps cancel to the path, and forwards a body only when one was sent', async () => {
    const bare = setup(deliveredFor('cancelCheckoutSession'));
    await send(bare.context, { url: `${MOUNT}/checkout_sessions/cs_9/cancel` });
    expect(firstRequest(bare.execute).input).toEqual({ path: { checkout_session_id: 'cs_9' } });

    const withBody = setup(deliveredFor('cancelCheckoutSession'));
    await send(withBody.context, {
      url: `${MOUNT}/checkout_sessions/cs_9/cancel`,
      body: { intent_trace: { reason_code: 'buyer_cancelled' } },
    });
    expect(firstRequest(withBody.execute).input).toEqual({
      path: { checkout_session_id: 'cs_9' },
      body: { intent_trace: { reason_code: 'buyer_cancelled' } },
    });
  });

  it('generates its own request id rather than trusting the caller', async () => {
    const { context, execute } = setup(deliveredFor('createCheckoutSession'));
    await send(context, { url: `${MOUNT}/checkout_sessions`, body: CREATE_BODY });

    expect(firstRequest(execute).requestId).toMatch(/^acp-/);
  });

  // Config refuses a paid checkout resource, so this can only be a broken
  // deployment - and ACP has no way to express a gateway payment challenge.
  it('fails safely when the pipeline answers payment-required', async () => {
    const { context } = setup(paymentRequired);
    const result = await send(context, { url: `${MOUNT}/checkout_sessions`, body: CREATE_BODY });

    expect(result.status).toBe(500);
    expect(result.body['type']).toBe('processing_error');
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain('0x1111111111111111111111111111111111111111');
    expect(serialized).not.toContain('x402');
  });

  it('discloses nothing when the pipeline throws', async () => {
    const { context } = setup(new Error('backend refused: postgres://user:pw@db/orders'));
    const result = await send(context, { url: `${MOUNT}/checkout_sessions`, body: CREATE_BODY });

    expect(result.status).toBe(500);
    expect(JSON.stringify(result.body)).not.toContain('postgres');
  });
});

describe('ACP adapter isolation', () => {
  const dir = join(process.cwd(), 'src/protocols/acp');
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((file) =>
    file.endsWith('.ts'),
  );

  it('never calls a merchant backend or touches payment machinery', () => {
    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf8');
      // `import type { IncomingMessage }` is fine; a value import of a client
      // is not.
      expect(source, `${file} must not import an HTTP client`).not.toMatch(
        /^import\s+(?!type)[^;]*from\s+'node:(http|https|net|tls)'/m,
      );
      expect(source, `${file} must not import undici or axios`).not.toMatch(
        /from\s+'(undici|axios|got|node-fetch)'/,
      );
      expect(source, `${file} must not verify or settle payments`).not.toMatch(
        /\b(verifyPayment|settlePayment|createPaymentProvider|PAYMENT_INPUT_FIELD)\b/,
      );
    }
  });
});
