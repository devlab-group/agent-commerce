/**
 * The x402 A2A extension over the real gateway: the real x402 and MPP
 * providers, the real A2A adapter, and an `@x402/core` client building the
 * `PaymentPayload`. Only the facilitator HTTP client is mocked.
 */
import { x402Client } from '@x402/core/client';
import type { PaymentRequired } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayConfig } from '../../src/config';
import type { CanonicalRequest, CommerceResource, PaymentMethodName } from '../../src/core';
import { createGateway, type GatewayInstance } from '../../src/gateway';
import { createMppPaymentProvider } from '../../src/payments/mpp/provider';
import { createX402PaymentProvider } from '../../src/payments/x402/provider';
import { createA2aAdapter } from '../../src/protocols/a2a';
import type { A2aAgentCard, A2aTask } from '../../src/protocols/a2a/types';
import { A2A_X402_EXTENSION_URI } from '../../src/protocols/a2a/x402-extension';
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
    network: 'eip155:84532',
    payer: buyer.address,
  });
  gateway = await createGateway({
    config: config(),
    store: createFakeStore(),
    paymentProviders: [
      createX402PaymentProvider({
        network: 'eip155:84532',
        rpcUrl: RPC_URL,
        asset: ASSET,
        assetName: AUTHORIZATION.name,
        assetVersion: AUTHORIZATION.version,
        assetDecimals: 6,
        payTo: PAY_TO,
        facilitator: REMOTE,
      }),
      createMppPaymentProvider({
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
  return { headers: res.headers, body: res.json() };
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
  registerExactEvmScheme(payments, { signer: buyer, networks: ['eip155:84532'] });
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
          accepts: [expect.objectContaining({ scheme: 'exact', network: 'eip155:84532' })],
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
        expect.objectContaining({ success: true, transaction: TX, network: 'eip155:84532' }),
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

    expect(body.error?.code).toBe(-32001);
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
    expect(failed?.status.message?.metadata).toMatchObject({
      'x402.payment.status': 'payment-failed',
      'x402.payment.error': 'insufficient_funds',
      'x402.payment.receipts': [
        expect.objectContaining({ success: false, network: 'eip155:84532' }),
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
    expect(again.body.error?.code).toBe(-32001);
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

  it.each(['GetTask', 'CancelTask'])(
    'answers %s on a pending task with TaskNotFoundError and keeps it payable',
    async (method) => {
      const task = await challenged();

      const lookup = await call(method, { id: task.id });
      expect(lookup.body.error?.code).toBe(-32001);
      expect(lookup.headers['a2a-extensions']).toBeUndefined();

      const { body } = await rpc(
        pay(task, {
          'x402.payment.status': 'payment-submitted',
          'x402.payment.payload': await paymentPayload(task),
        }),
      );
      expect(body.result?.task.status.state).toBe('TASK_STATE_COMPLETED');
    },
  );
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
