/**
 * The x402 A2A extension over the real gateway: the real x402 and MPP
 * providers, the real A2A adapter, and an `@x402/core` client building the
 * `PaymentPayload`. Only the facilitator HTTP client is mocked.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { x402Client } from '@x402/core/client';
import type { PaymentRequired } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayConfig } from '../../src/config';
import type {
  CanonicalRequest,
  CommerceResource,
  PaymentMethodName,
  ReceiptStore,
} from '../../src/core';
import { createGateway, type GatewayInstance } from '../../src/gateway';
import { createMppPaymentProvider } from '../../src/payments/mpp/provider';
import { createX402PaymentProvider } from '../../src/payments/x402/provider';
import { createA2aAdapter } from '../../src/protocols/a2a';
import type { A2aAgentCard, A2aTask } from '../../src/protocols/a2a/types';
import { A2A_X402_EXTENSION_URI } from '../../src/protocols/a2a/x402-extension';
import { createSqliteReceiptStore } from '../../src/storage/receipts';
import { tckErrors } from '../conformance/a2a/support/task-schema';
import { createFakeStore } from '../unit/gateway/helpers';

process.env['NODE_ENV'] = 'test';

const facilitator = vi.hoisted(() => ({ verify: vi.fn(), settle: vi.fn() }));
vi.mock('@x402/core/http', () => ({
  FacilitatorResponseError: class extends Error {},
  HTTPFacilitatorClient: class {
    verify(...args: unknown[]) {
      return facilitator.verify(...args);
    }
    settle(...args: unknown[]) {
      return facilitator.settle(...args);
    }
  },
}));

const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
const PAY_TO = '0x1111111111111111111111111111111111111111' as const;
const AUTHORIZATION = { name: 'MockUSDC', version: '2' };
const RPC_URL = 'http://127.0.0.1:19321'; // facilitator client is mocked
const TX = `0x${'cd'.repeat(32)}`;
const REMOTE = {
  mode: 'remote',
  url: 'https://facilitator.example.com',
  auth: { type: 'none' },
} as const;
const buyer = privateKeyToAccount(generatePrivateKey());
const X402_OPTIONS = {
  network: 'eip155:31337',
  rpcUrl: RPC_URL,
  asset: ASSET,
  assetName: AUTHORIZATION.name,
  assetVersion: AUTHORIZATION.version,
  assetDecimals: 6,
  payTo: PAY_TO,
  facilitator: REMOTE,
} as const;

let gateway: GatewayInstance;
let backendCalls = 0;

function resource(id: string, rail: PaymentMethodName): CommerceResource {
  return {
    id,
    name: id,
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' } } },
    handler: { type: 'http', method: 'GET', url: 'http://backend.local/report' },
    pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
    exposedVia: ['a2a'],
    paymentMethods: [rail],
  };
}

function config(): GatewayConfig {
  return {
    version: 1,
    merchant: { id: 'demo-store', name: 'Demo Store', publicBaseUrl: 'http://localhost:8080' },
    server: { port: 0, host: '127.0.0.1', allowedOrigins: [] },
    storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
    protocols: {
      http: { enabled: false },
      mcp: { enabled: false, mountPath: '/mcp' },
      a2a: { enabled: true, mountPath: '/a2a' },
      acp: { enabled: false, mountPath: '/acp' },
    },
    resources: [resource('x402_report', 'x402'), resource('mpp_report', 'mpp')],
    payments: {},
  };
}

beforeEach(async () => {
  backendCalls = 0;
  facilitator.verify.mockReset().mockResolvedValue({ isValid: true, payer: buyer.address });
  facilitator.settle.mockReset().mockResolvedValue({
    success: true,
    transaction: TX,
    network: 'eip155:31337',
    payer: buyer.address,
  });
  gateway = await createGateway({
    config: config(),
    store: createFakeStore(),
    paymentProviders: [
      createX402PaymentProvider(X402_OPTIONS),
      createMppPaymentProvider({
        network: 'eip155:31337',
        recipient: PAY_TO,
        asset: ASSET,
        assetName: AUTHORIZATION.name,
        assetVersion: AUTHORIZATION.version,
        realm: 'gateway.test',
        challengeSecret: 's'.repeat(32),
        rpcUrl: RPC_URL,
        facilitator: REMOTE,
      }),
    ],
    protocolAdapters: [createA2aAdapter()],
    backend: {
      async call() {
        backendCalls++;
        return { status: 200, body: { report: 'paid' }, headers: {}, durationMs: 1 };
      },
    },
  });
});

afterEach(async () => {
  await gateway.close().catch(() => {});
});

interface RpcResult {
  readonly headers: Record<string, unknown>;
  readonly body: {
    // `{ task }` for SendMessage; the task itself for GetTask and CancelTask
    result?: { task: A2aTask };
    error?: { code: number; message: string };
  };
}

async function call(
  method: string,
  params: Record<string, unknown>,
  extension = true,
): Promise<RpcResult> {
  const res = await gateway.server.inject({
    method: 'POST',
    url: '/a2a',
    headers: {
      'content-type': 'application/json',
      'a2a-version': '1.0',
      ...(extension ? { 'a2a-extensions': A2A_X402_EXTENSION_URI } : {}),
    },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 'req-1', method, params }),
  });
  const body: RpcResult['body'] = res.json();
  // Every task answered here passes the TCK's response schema
  if (body.result !== undefined) {
    const schema = method === 'SendMessage' ? 'Send Message Response' : 'Task';
    expect(tckErrors(schema, body.result), `${method} result against the TCK schema`).toEqual([]);
  }
  return { headers: res.headers, body };
}

function rpc(message: Record<string, unknown>, extension = true): Promise<RpcResult> {
  return call('SendMessage', { message }, extension);
}

// The requests the adapter hands the pipeline
function spyOnPipeline(): CanonicalRequest[] {
  const captured: CanonicalRequest[] = [];
  const original = gateway.pipeline.execute.bind(gateway.pipeline);
  (gateway.pipeline as { execute: typeof original }).execute = async (request) => {
    captured.push(request);
    return original(request);
  };
  return captured;
}

const MANDATE = { method: 'ap2', payload: 'eyJhbGciOiJFUzI1NiJ9.checkout-mandate~disclosure-0~' };

function buy(resourceId: string): Record<string, unknown> {
  return {
    role: 'ROLE_USER',
    messageId: 'msg-buy',
    parts: [
      {
        data: { resource: resourceId, input: { symbol: 'ETH' } },
        mediaType: 'application/json',
      },
    ],
  };
}

function pay(task: A2aTask, metadata: Record<string, unknown>): Record<string, unknown> {
  return {
    role: 'ROLE_USER',
    messageId: 'msg-pay',
    taskId: task.id,
    contextId: task.contextId,
    parts: [{ text: 'Here is the payment authorization.' }],
    metadata,
  };
}

async function paymentPayload(task: A2aTask): Promise<Record<string, unknown>> {
  const payments = new x402Client();
  registerExactEvmScheme(payments, { signer: buyer, networks: ['eip155:31337'] });
  // The test token is not in the SDK's spend-control asset list
  payments.setSpendControls(false);
  const required = task.status.message?.metadata?.['x402.payment.required'] as PaymentRequired;
  return (await payments.createPaymentPayload(required)) as unknown as Record<string, unknown>;
}

async function challenged(): Promise<A2aTask> {
  const { body } = await rpc(buy('x402_report'));
  const task = body.result?.task;
  expect(task?.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
  return task as A2aTask;
}

describe('x402 A2A extension', () => {
  it('advertises the optional extension in the Agent Card', async () => {
    const res = await gateway.server.inject({ method: 'GET', url: '/.well-known/agent-card.json' });
    expect(res.json<A2aAgentCard>().capabilities.extensions).toEqual([
      expect.objectContaining({
        uri: A2A_X402_EXTENSION_URI,
        required: false,
        params: { x402Version: 2 },
      }),
    ]);
  });

  it('asks for payment with an input-required task carrying the x402 v2 document', async () => {
    const { headers, body } = await rpc(buy('x402_report'));

    expect(headers['a2a-extensions']).toBe(A2A_X402_EXTENSION_URI);
    const task = body.result?.task;
    expect(task?.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(task?.status.message).toMatchObject({
      role: 'ROLE_AGENT',
      taskId: task?.id,
      contextId: task?.contextId,
      extensions: [A2A_X402_EXTENSION_URI],
      metadata: {
        'x402.payment.status': 'payment-required',
        'x402.payment.required': {
          x402Version: 2,
          accepts: [expect.objectContaining({ scheme: 'exact', network: 'eip155:31337' })],
        },
      },
    });
    expect(backendCalls).toBe(0);
  });

  it('settles a payment sent on the task and completes it with the receipt', async () => {
    const task = await challenged();

    const { body } = await rpc(
      pay(task, {
        'x402.payment.status': 'payment-submitted',
        'x402.payment.payload': await paymentPayload(task),
      }),
    );

    const paid = body.result?.task;
    expect(paid).toMatchObject({ id: task.id, contextId: task.contextId });
    expect(paid?.status.state).toBe('TASK_STATE_COMPLETED');
    expect(paid?.status.message).toMatchObject({
      taskId: task.id,
      contextId: task.contextId,
      extensions: [A2A_X402_EXTENSION_URI],
    });
    expect(paid?.status.message?.metadata).toMatchObject({
      'x402.payment.status': 'payment-completed',
      'x402.payment.receipts': [
        expect.objectContaining({ success: true, transaction: TX, network: 'eip155:31337' }),
      ],
    });
    expect(paid?.artifacts[0]?.parts[0]?.data).toEqual({ report: 'paid' });
    expect(backendCalls).toBe(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('refuses a second payment on a task already paid', async () => {
    const task = await challenged();
    const message = pay(task, {
      'x402.payment.status': 'payment-submitted',
      'x402.payment.payload': await paymentPayload(task),
    });
    await rpc(message);

    const { body } = await rpc(message);

    // The task's record remains: it accepts no further messages
    expect(body.error?.code).toBe(-32004);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('fails the task with the reason when the payment is refused', async () => {
    facilitator.verify.mockResolvedValueOnce({
      isValid: false,
      invalidReason: 'insufficient_funds',
    });
    const task = await challenged();

    const { body } = await rpc(
      pay(task, {
        'x402.payment.status': 'payment-submitted',
        'x402.payment.payload': await paymentPayload(task),
      }),
    );

    const failed = body.result?.task;
    expect(failed?.status.state).toBe('TASK_STATE_FAILED');
    expect(failed?.status.message?.parts).toEqual([{ text: 'Payment failed.' }]);
    expect(failed?.status.message?.metadata).toMatchObject({
      'x402.payment.status': 'payment-failed',
      'x402.payment.error': 'insufficient_funds',
      'x402.payment.receipts': [
        expect.objectContaining({ success: false, network: 'eip155:31337' }),
      ],
    });
    expect(backendCalls).toBe(0);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it('ends the task when the client declines to pay', async () => {
    const task = await challenged();

    const { body } = await rpc(pay(task, { 'x402.payment.status': 'payment-rejected' }));

    expect(body.result?.task.status).toMatchObject({
      state: 'TASK_STATE_FAILED',
      message: { metadata: { 'x402.payment.status': 'payment-rejected' } },
    });
    const again = await rpc(pay(task, { 'x402.payment.status': 'payment-rejected' }));
    expect(again.body.error?.code).toBe(-32004);
  });

  // A full store must preserve purchases whose buyers may have signed.
  // New purchases are rejected until a slot is free.
  it('refuses a new purchase while every pending slot is taken, and keeps the waiting ones', async () => {
    const first = await challenged();
    for (let i = 1; i < 256; i++) await challenged();

    const { body } = await rpc(buy('x402_report'));
    const busy = body.result?.task;
    expect(busy?.status.state).toBe('TASK_STATE_FAILED');
    expect(busy?.artifacts?.[0]?.parts[0]?.data).toMatchObject({
      code: 'GATEWAY_BUSY',
      retryable: true,
    });
    // The refused task's record shows the refusal, not a payment it cannot take
    expect((await call('GetTask', { id: busy?.id })).body.result).toEqual(busy);

    const paid = await rpc(
      pay(first, {
        'x402.payment.status': 'payment-submitted',
        'x402.payment.payload': await paymentPayload(first),
      }),
    );
    expect(paid.body.result?.task.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('keeps the task waiting after a malformed payment message', async () => {
    const task = await challenged();

    const malformed = await rpc(pay(task, { 'x402.payment.status': 'payment-submitted' }));
    expect(malformed.body.error?.code).toBe(-32602);

    const { body } = await rpc(
      pay(task, {
        'x402.payment.status': 'payment-submitted',
        'x402.payment.payload': await paymentPayload(task),
      }),
    );
    expect(body.result?.task.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('refuses a payment with another contextId and keeps the task', async () => {
    const task = await challenged();
    const submitted = {
      'x402.payment.status': 'payment-submitted',
      'x402.payment.payload': await paymentPayload(task),
    };

    const mismatched = await rpc(pay({ ...task, contextId: 'another-context' }, submitted));
    expect(mismatched.body.error?.code).toBe(-32602);

    const { body } = await rpc(pay(task, submitted));
    expect(body.result?.task.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('pays a task named with proto field names', async () => {
    const task = await challenged();
    const { taskId, contextId, messageId, ...rest } = pay(task, {
      'x402.payment.status': 'payment-submitted',
      'x402.payment.payload': await paymentPayload(task),
    });

    const { body } = await rpc({
      ...rest,
      task_id: taskId,
      context_id: contextId,
      message_id: messageId,
    });

    expect(body.result?.task).toMatchObject({
      id: task.id,
      status: { state: 'TASK_STATE_COMPLETED' },
    });
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('leaves snake_case keys in the merchant input and the payment metadata as sent', async () => {
    const requests = spyOnPipeline();
    const purchase = buy('x402_report');
    const [part] = purchase['parts'] as Record<string, unknown>[];
    const { body: challenge } = await rpc({
      ...purchase,
      parts: [{ ...part, data: { resource: 'x402_report', input: { symbol: 'ETH', max_age: 5 } } }],
    });
    const task = challenge.result?.task as A2aTask;
    const payload = await paymentPayload(task);
    const signed = { ...(payload['payload'] as Record<string, unknown>), buyer_note: 'n' };

    const { body } = await rpc(
      pay(task, {
        'x402.payment.status': 'payment-submitted',
        'x402.payment.payload': { ...payload, payload: signed },
      }),
    );

    expect(body.result?.task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(requests.map((request) => request.input)).toEqual([
      { symbol: 'ETH', max_age: 5 },
      { symbol: 'ETH', max_age: 5 },
    ]);
    expect(facilitator.verify.mock.calls[0]?.[0]).toMatchObject({ payload: { buyer_note: 'n' } });
  });

  it('answers a task id it never issued with TaskNotFoundError', async () => {
    const { body } = await rpc(
      pay(
        {
          id: 'task-unknown',
          contextId: 'ctx',
          status: { state: '', timestamp: '' },
          artifacts: [],
        },
        {
          'x402.payment.status': 'payment-submitted',
          'x402.payment.payload': {},
        },
      ),
    );
    expect(body.error?.code).toBe(-32001);
  });

  it.each([
    ['a client that does not activate the extension', 'x402_report', false],
    ['a resource paid with MPP', 'mpp_report', true],
  ])('keeps the terminal payment-required task for %s', async (_label, resourceId, extension) => {
    const { headers, body } = await rpc(buy(resourceId), extension);

    const task = body.result?.task;
    expect(task?.status.state).toBe('TASK_STATE_FAILED');
    // A plain reason, with nothing from the extension and no echoed header
    expect(task?.status.message?.parts[0]?.text).toContain('Payment of 0.01 USDC is required');
    expect(task?.status.message).not.toHaveProperty('metadata');
    expect(task?.status.message).not.toHaveProperty('extensions');
    expect(headers['a2a-extensions']).toBeUndefined();
  });

  it('echoes the extension header on a follow-up sent without it', async () => {
    const task = await challenged();

    const { headers, body } = await rpc(
      pay(task, {
        'x402.payment.status': 'payment-submitted',
        'x402.payment.payload': await paymentPayload(task),
      }),
      false,
    );

    expect(body.result?.task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(headers['a2a-extensions']).toBe(A2A_X402_EXTENSION_URI);
  });

  it('names the version when the payload is x402 v1', async () => {
    const task = await challenged();

    const { body } = await rpc(
      pay(task, {
        'x402.payment.status': 'payment-submitted',
        'x402.payment.payload': {
          x402Version: 1,
          scheme: 'exact',
          network: 'base-sepolia',
          payload: {},
        },
      }),
    );

    expect(body.result?.task.status.message?.metadata).toMatchObject({
      'x402.payment.status': 'payment-failed',
      'x402.payment.error': 'invalid_x402_version',
    });
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(backendCalls).toBe(0);
  });

  it('refuses a follow-up in the A2A 0.x shape and keeps the task', async () => {
    const task = await challenged();
    const submitted = {
      'x402.payment.status': 'payment-submitted',
      'x402.payment.payload': await paymentPayload(task),
    };

    const legacy = await rpc({
      ...pay(task, submitted),
      role: 'user',
      parts: [{ kind: 'text', text: 'Here is the payment authorization.' }],
    });
    expect(legacy.body.error).toMatchObject({
      code: -32602,
      message: 'Unsupported message role "user": only ROLE_USER is accepted.',
    });
    expect(facilitator.verify).not.toHaveBeenCalled();

    const { body } = await rpc(pay(task, submitted));
    expect(body.result?.task.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('answers GetTask on a pending task with the task as sent, and keeps it payable', async () => {
    const task = await challenged();

    const lookup = await call('GetTask', { id: task.id }, false);
    expect(lookup.body.result).toEqual(task);
    // The task's metadata keys belong to the extension, which the response names
    expect(lookup.headers['a2a-extensions']).toBe(A2A_X402_EXTENSION_URI);

    const { body } = await rpc(
      pay(task, {
        'x402.payment.status': 'payment-submitted',
        'x402.payment.payload': await paymentPayload(task),
      }),
    );
    expect(body.result?.task.status.state).toBe('TASK_STATE_COMPLETED');
    expect((await call('GetTask', { id: task.id })).body.result).toEqual(body.result?.task);
  });

  it('cancels a pending task, which then takes no payment, and cancels it again unchanged', async () => {
    const task = await challenged();

    const canceled = (await call('CancelTask', { id: task.id })).body.result as unknown as A2aTask;
    expect(canceled).toMatchObject({
      id: task.id,
      contextId: task.contextId,
      status: { state: 'TASK_STATE_CANCELED', message: { parts: [{ text: 'Task canceled.' }] } },
      artifacts: [],
    });
    expect(canceled.status.message).not.toHaveProperty('metadata');

    const payment = await rpc(
      pay(task, {
        'x402.payment.status': 'payment-submitted',
        'x402.payment.payload': await paymentPayload(task),
      }),
    );
    expect(payment.body.error?.code).toBe(-32004);
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(backendCalls).toBe(0);
    expect((await call('CancelTask', { id: task.id })).body.result).toEqual(canceled);
    expect((await call('GetTask', { id: task.id })).body.result).toEqual(canceled);
  });

  it('refuses to cancel a paid task', async () => {
    const task = await challenged();
    await rpc(
      pay(task, {
        'x402.payment.status': 'payment-submitted',
        'x402.payment.payload': await paymentPayload(task),
      }),
    );

    const { body } = await call('CancelTask', { id: task.id });

    expect(body.error?.code).toBe(-32002);
    expect((await call('GetTask', { id: task.id })).body.result).toMatchObject({
      status: { state: 'TASK_STATE_COMPLETED' },
    });
  });
});

describe('an AP2 mandate sent with the x402 extension payment', () => {
  // Another resource and input beside the mandate, which must not be used
  function mandatePart(authorization: unknown): Record<string, unknown> {
    return {
      data: {
        resource: 'mpp_report',
        input: { symbol: 'BTC', _authorization: authorization },
      },
      mediaType: 'application/json',
    };
  }

  async function submitted(task: A2aTask): Promise<Record<string, unknown>> {
    return {
      'x402.payment.status': 'payment-submitted',
      'x402.payment.payload': await paymentPayload(task),
    };
  }

  it('reaches the pipeline with the stored purchase', async () => {
    const task = await challenged();
    const requests = spyOnPipeline();

    const { body } = await rpc({
      ...pay(task, await submitted(task)),
      parts: [{ text: 'Payment and mandate.' }, mandatePart(MANDATE)],
    });

    expect(body.result?.task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      resourceId: 'x402_report',
      input: { symbol: 'ETH' },
      authorization: MANDATE,
    });
  });

  it('keeps the mandate stored from the first message', async () => {
    const first = buy('x402_report');
    const { body: challenge } = await rpc({
      ...first,
      parts: [
        {
          data: { resource: 'x402_report', input: { symbol: 'ETH', _authorization: MANDATE } },
          mediaType: 'application/json',
        },
      ],
    });
    const task = challenge.result?.task as A2aTask;
    const requests = spyOnPipeline();

    await rpc({
      ...pay(task, await submitted(task)),
      parts: [mandatePart({ method: 'ap2', payload: 'another-mandate~' })],
    });

    expect(requests[0]?.authorization).toEqual(MANDATE);
  });

  it('refuses a malformed mandate and keeps the task payable', async () => {
    const task = await challenged();
    const requests = spyOnPipeline();

    const malformed = await rpc({
      ...pay(task, await submitted(task)),
      parts: [mandatePart({ method: 'unknown', payload: 'x' })],
    });
    expect(malformed.body.error?.code).toBe(-32602);
    expect(malformed.body.error?.message).toContain('Malformed authorization');
    expect(requests).toHaveLength(0);

    const { body } = await rpc(pay(task, await submitted(task)));
    expect(body.result?.task.status.state).toBe('TASK_STATE_COMPLETED');
  });
});

describe('x402 A2A extension with the public resource URL, across a restart', () => {
  const A2A_URL = 'http://localhost:8080/a2a';
  let dir = '';
  let store: ReceiptStore | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'a2a-public-url-'));
  });

  afterEach(async () => {
    await gateway.close().catch(() => {});
    await store?.close();
    store = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  // Use the shared receipt file to preserve tasks awaiting payment across boots
  async function boot(publicUrl: boolean): Promise<void> {
    await gateway.close().catch(() => {});
    await store?.close();
    store = createSqliteReceiptStore({ path: join(dir, 'receipts.db') });
    await store.init();
    gateway = await createGateway({
      config: config(),
      store,
      paymentProviders: [
        createX402PaymentProvider({
          ...X402_OPTIONS,
          ...(publicUrl ? { resourceUrls: { x402_report: { a2a: A2A_URL } } } : {}),
        }),
      ],
      protocolAdapters: [createA2aAdapter({ store })],
      backend: {
        async call() {
          backendCalls++;
          return { status: 200, body: { report: 'paid' }, headers: {}, durationMs: 1 };
        },
      },
    });
  }

  const submitted = async (task: A2aTask) => ({
    'x402.payment.status': 'payment-submitted',
    'x402.payment.payload': await paymentPayload(task),
  });

  it('pays a task after a restart, its proof echoing the A2A URL, and settles once', async () => {
    await boot(true);
    const task = await challenged();
    const required = task.status.message?.metadata?.['x402.payment.required'] as PaymentRequired;
    expect(required.resource.url).toBe(A2A_URL);
    const metadata = await submitted(task);

    await boot(true);
    const { body } = await rpc(pay(task, metadata));

    expect(body.result?.task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(backendCalls).toBe(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('refuses a task challenged before the URL was turned on, and settles nothing', async () => {
    await boot(false);
    const task = await challenged();
    const metadata = await submitted(task);

    await boot(true);
    const { body } = await rpc(pay(task, metadata));

    expect(body.result?.task.status.state).toBe('TASK_STATE_FAILED');
    expect(body.result?.task.status.message?.metadata).toMatchObject({
      'x402.payment.status': 'payment-failed',
      'x402.payment.error': 'invalid_payment_requirements',
    });
    expect(backendCalls).toBe(0);
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });
});
