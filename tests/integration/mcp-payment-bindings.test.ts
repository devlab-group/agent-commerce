/**
 * Exercise both rails' MCP bindings against the gateway: `@x402/mcp` for
 * x402 and `mppx/mcp/client` for MPP. Only the facilitator HTTP client is
 * mocked.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { x402Client } from '@x402/core/client';
import type { PaymentRequired } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { wrapMCPClientWithPayment } from '@x402/mcp';
import { type Challenge, Credential } from 'mppx';
import { charge as clientCharge } from 'mppx/evm/client';
import { McpClient } from 'mppx/mcp/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayConfig } from '../../src/config';
import type { CommerceResource, PaymentMethodName } from '../../src/core';
import { createGateway, type GatewayInstance } from '../../src/gateway';
import { createMppPaymentProvider } from '../../src/payments/mpp/provider';
import { createX402PaymentProvider } from '../../src/payments/x402/provider';
import { createMcpAdapter } from '../../src/protocols/mcp';
import { createFakeStore } from '../unit/gateway/helpers';

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
const TX = `0x${'ab'.repeat(32)}`;
const REMOTE = {
  mode: 'remote',
  url: 'https://facilitator.example.com',
  auth: { type: 'none' },
} as const;
const buyer = privateKeyToAccount(generatePrivateKey());

type EvmChallenge = Parameters<ReturnType<typeof clientCharge>['createCredential']>[0]['challenge'];

let gateway: GatewayInstance | undefined;
let url = '';
const clients: Client[] = [];

function resource(id: string, rail: PaymentMethodName): CommerceResource {
  return {
    id,
    name: id,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: { type: 'http', method: 'GET', url: 'http://backend.local/report' },
    pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
    exposedVia: ['mcp'],
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
      http: { enabled: true },
      mcp: { enabled: true, mountPath: '/mcp' },
      a2a: { enabled: false, mountPath: '/a2a' },
      acp: { enabled: false, mountPath: '/acp' },
    },
    resources: [resource('x402_report', 'x402'), resource('mpp_report', 'mpp')],
    payments: {},
  };
}

beforeEach(async () => {
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
    protocolAdapters: [createMcpAdapter()],
    backend: {
      async call() {
        return { status: 200, body: { report: 'paid' }, headers: {}, durationMs: 1 };
      },
    },
  });
  ({ url } = await gateway.listen());
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await gateway?.close().catch(() => {});
  gateway = undefined;
});

async function connect(): Promise<Client> {
  const client = new Client({ name: 'binding-test-buyer', version: '0.0.0-test' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)) as Transport);
  clients.push(client);
  return client;
}

function x402Payments(): x402Client {
  const payments = new x402Client();
  registerExactEvmScheme(payments, { signer: buyer, networks: ['eip155:84532'] });
  // Disable SDK spend controls because the test token is not in its asset list
  payments.setSpendControls(false);
  return payments;
}

function firstText(result: CallToolResult): string {
  return String((result.content[0] as { text: string }).text);
}

describe('x402 MCP transport', () => {
  it('lets an @x402/mcp client pay through _meta and read the settlement response', async () => {
    const client = wrapMCPClientWithPayment(await connect(), x402Payments(), {
      autoPayment: true,
    });

    const result = await client.callTool('x402_report', {});

    expect(result.paymentMade).toBe(true);
    expect(result.isError).not.toBe(true);
    expect(result.paymentResponse).toMatchObject({
      success: true,
      transaction: TX,
      network: 'eip155:84532',
      amount: '10000',
    });
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('repeats PaymentRequired as JSON in content[0].text', async () => {
    const challenged = (await (
      await connect()
    ).callTool({
      name: 'x402_report',
      arguments: {},
    })) as CallToolResult;

    expect(challenged.isError).toBe(true);
    expect(challenged.structuredContent).toMatchObject({
      x402Version: 2,
      accepts: [{ scheme: 'exact', extra: { paymentFlow: 'upfront' } }],
      code: 'PAYMENT_REQUIRED',
    });
    expect(JSON.parse(firstText(challenged))).toEqual(challenged.structuredContent);
  });

  it('returns a new PaymentRequired with the refusal reason', async () => {
    const client = await connect();
    const challenged = (await client.callTool({
      name: 'x402_report',
      arguments: {},
    })) as CallToolResult;
    const payload = await x402Payments().createPaymentPayload(
      challenged.structuredContent as unknown as PaymentRequired,
    );
    facilitator.verify.mockResolvedValueOnce({
      isValid: false,
      invalidReason: 'insufficient_funds',
    });

    const refused = (await client.callTool({
      name: 'x402_report',
      arguments: {},
      _meta: { 'x402/payment': payload },
    })) as CallToolResult;

    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({
      x402Version: 2,
      error: 'insufficient_funds',
      code: 'PAYMENT_INVALID',
    });
    expect(facilitator.settle).not.toHaveBeenCalled();
  });
});

describe('MPP MCP transport', () => {
  it('lets an mppx MCP client pay through _meta and read the receipt', async () => {
    const client = await connect();
    McpClient.wrap(client, {
      methods: [clientCharge({ account: buyer, authorization: AUTHORIZATION })],
    });

    const result = (await client.callTool({
      name: 'mpp_report',
      arguments: {},
    })) as CallToolResult & {
      receipt?: unknown;
    };

    expect(result.isError).not.toBe(true);
    expect(result.receipt).toMatchObject({
      method: 'evm',
      status: 'success',
      reference: TX,
      chainId: 84532,
    });
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('returns new challenges and a problem type, without a receipt, for a refused credential', async () => {
    const client = await connect();
    const challenged = (await client.callTool({
      name: 'mpp_report',
      arguments: {},
    })) as CallToolResult;
    const required = challenged._meta?.['org.paymentauth/payment-required'] as {
      challenges: Challenge.Challenge[];
    };
    const serialized = await clientCharge({
      account: buyer,
      authorization: AUTHORIZATION,
    }).createCredential({ challenge: required.challenges[0] as EvmChallenge, context: {} });
    facilitator.verify.mockResolvedValueOnce({
      isValid: false,
      invalidReason: 'insufficient_funds',
    });

    const refused = (await client.callTool({
      name: 'mpp_report',
      arguments: {},
      _meta: { 'org.paymentauth/credential': Credential.deserialize(String(serialized)) },
    })) as CallToolResult;

    expect(refused.isError).toBe(true);
    const fresh = refused._meta?.['org.paymentauth/payment-required'] as {
      challenges: Challenge.Challenge[];
      problem: Record<string, unknown>;
    };
    expect(fresh.challenges[0]?.id).not.toBe(required.challenges[0]?.id);
    expect(fresh.problem).toMatchObject({
      type: 'https://paymentauth.org/problems/verification-failed',
      detail: 'insufficient_funds',
    });
    expect(refused._meta?.['org.paymentauth/receipt']).toBeUndefined();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });
});
