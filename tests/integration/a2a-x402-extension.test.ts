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
import type { CommerceResource, PaymentMethodName } from '../../src/core';
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

async function rpc(message: Record<string, unknown>, extension = true): Promise<RpcResult> {
  const res = await gateway.server.inject({
    method: 'POST',
    url: '/a2a',
    headers: {
      'content-type': 'application/json',
      'a2a-version': '1.0',
      ...(extension ? { 'a2a-extensions': A2A_X402_EXTENSION_URI } : {}),
    },
    payload: JSON.stringify({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'SendMessage',
      params: { message },
    }),
  });
  return { headers: res.headers, body: res.json() };
}

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
      expect.objectContaining({ uri: A2A_X402_EXTENSION_URI, required: false }),
    ]);
  });

  it('asks for payment with an input-required task carrying the x402 v2 document', async () => {
    const { headers, body } = await rpc(buy('x402_report'));

    expect(headers['a2a-extensions']).toBe(A2A_X402_EXTENSION_URI);
    const task = body.result?.task;
    expect(task?.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(task?.status.message).toMatchObject({
      role: 'ROLE_AGENT',
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
      'x402.payment.receipts': [expect.objectContaining({ success: false })],
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
    expect(task?.status.message).toBeUndefined();
    expect(headers['a2a-extensions']).toBe(extension ? A2A_X402_EXTENSION_URI : undefined);
  });
});
