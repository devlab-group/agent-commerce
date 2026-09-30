/**
 * Adversarial payment cases that need the pipeline, the store or a real HTTP
 * facilitator. The provider's own negative cases run against a real chain in
 * `tests/e2e/payment`. Covered here:
 *
 * - two identical requests in flight at once
 * - the same authorization replayed after a process restart
 * - a malformed PAYMENT-SIGNATURE, refused before the backend is called
 * - a facilitator that answers 401, 500, or a 200 that is not a verify response,
 *   at the binding and through the gateway
 * - a facilitator that refuses the payment with a 400 and a reason
 *
 * Offline: the facilitator is a loopback HTTP server started here, and no
 * chain is involved.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config';
import type {
  AdapterDescriptor,
  PaymentContext,
  PaymentProvider,
  PaymentRequirement,
  PaymentResult,
  PaymentSettlementContext,
  PaymentVerificationContext,
  ReceiptStore,
} from '../../src/core';
import { createGateway, type GatewayInstance } from '../../src/gateway';
import { createPaymentProof } from '../../src/payments/x402/client';
import {
  LOCAL_BUYER_ACCOUNT,
  LOCAL_FACILITATOR_ACCOUNT,
} from '../../src/payments/x402/local-chain/accounts';
import { createX402PaymentProvider } from '../../src/payments/x402/provider';
import { createSqliteReceiptStore } from '../../src/storage/receipts';

const RESOURCE_ID = 'paid_report';
const VALID_PROOF = 'valid-proof';

function rawConfig(storePath: string): Record<string, unknown> {
  return {
    version: 1,
    merchant: { id: 'adversarial', name: 'Adversarial', publicBaseUrl: 'http://127.0.0.1:8080' },
    server: { port: 8080, host: '127.0.0.1', allowedOrigins: [] },
    storage: { receipts: { driver: 'sqlite', path: storePath } },
    protocols: { http: { enabled: true }, mcp: { enabled: false, mountPath: '/mcp' } },
    resources: {
      [RESOURCE_ID]: {
        name: 'Paid report',
        backend: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
        pricing: { type: 'fixed', amount: '0.01', currency: 'USD' },
        expose: ['http'],
        payments: ['x402'],
      },
    },
    payments: {
      x402: {
        enabled: true,
        network: 'eip155:84532',
        rpcUrl: 'http://127.0.0.1:8545',
        asset: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        assetName: 'MockUSDC',
        assetVersion: '2',
        assetDecimals: 6,
        payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        maxTimeoutSeconds: 120,
        facilitator: { mode: 'local', signerPrivateKey: '0xKEY' },
      },
    },
  };
}

const descriptor: AdapterDescriptor = {
  name: 'fake-x402',
  kind: 'payment',
  implementationVersion: '0.0.0-test',
  supportedSpec: 'x402/v2',
  capabilities: [],
  status: 'experimental',
};

/**
 * A provider whose `settle()` is slow and counted. An instant settle would let
 * two "concurrent" requests serialize by accident, and the replay test would
 * pass without proving anything.
 */
function countingProvider(settleDelayMs: number): PaymentProvider & { settleCalls: () => number } {
  let settleCalls = 0;
  return {
    name: 'x402',
    descriptor,
    settleCalls: () => settleCalls,
    createRequirement: async (ctx: PaymentContext): Promise<PaymentRequirement> => ({
      id: 'req-1',
      requestId: ctx.requestId,
      resourceId: ctx.resource.id,
      provider: 'x402',
      amount: ctx.amount,
      currency: ctx.currency,
      destination: '0xMERCHANT',
      challenge: { provider: 'x402', version: '2', accepts: [{ scheme: 'exact' }] },
    }),
    verify: async (ctx: PaymentVerificationContext): Promise<PaymentResult> =>
      ctx.submission.payload === VALID_PROOF
        ? {
            status: 'verified',
            provider: 'x402',
            amount: '0.01',
            currency: 'USDC',
            // One authorization, one key
            replayKey: '0xreplaykey',
          }
        : {
            status: 'rejected',
            provider: 'x402',
            amount: '0.01',
            currency: 'USDC',
            rejectionReason: 'invalid_payment',
          },
    settle: async (_ctx: PaymentSettlementContext): Promise<PaymentResult> => {
      settleCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, settleDelayMs));
      return {
        status: 'settled',
        provider: 'x402',
        amount: '0.01',
        currency: 'USDC',
        externalReference: '0xTXHASH',
        replayKey: '0xreplaykey',
      };
    },
    health: async () => ({ status: 'pass', checkedAt: new Date().toISOString() }),
  };
}

async function buildGateway(
  storePath: string,
  provider: PaymentProvider,
  onBackendCall: () => void = () => {},
): Promise<{ gateway: GatewayInstance; store: ReceiptStore }> {
  const config = parseConfig(rawConfig(storePath), {});
  const store = createSqliteReceiptStore({ path: storePath });
  await store.init();
  const gateway = await createGateway({
    config,
    store,
    paymentProviders: [provider],
    protocolAdapters: [],
    backend: {
      call: async () => {
        onBackendCall();
        return { status: 200, headers: {}, body: { ok: true }, durationMs: 1 };
      },
    },
  });
  return { gateway, store };
}

function invoke(gateway: GatewayInstance, proof: string) {
  return gateway.server.inject({
    method: 'POST',
    url: `/api/resources/${RESOURCE_ID}/invoke`,
    payload: {},
    headers: { 'payment-signature': proof },
  });
}

describe('adversarial: duplicate concurrent request', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oac-adversarial-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('settles exactly once when the same authorization arrives twice at the same moment', async () => {
    const provider = countingProvider(150);
    const { gateway } = await buildGateway(join(dir, 'concurrent.sqlite'), provider);

    // Both are in flight together. The first transaction has not landed, so no
    // on-chain nonce check helps; only the gateway's reservation stops one
    // authorization buying two deliveries.
    const [a, b] = await Promise.all([invoke(gateway, VALID_PROOF), invoke(gateway, VALID_PROOF)]);

    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    expect(provider.settleCalls()).toBe(1);

    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().code).toBe('PAYMENT_REPLAYED');

    await gateway.close();
  });

  it('still refuses the authorization after the gateway restarts', async () => {
    // The reservation lives in SQLite, so it must survive a restart
    const storePath = join(dir, 'restart.sqlite');

    const first = await buildGateway(storePath, countingProvider(0));
    expect((await invoke(first.gateway, VALID_PROOF)).statusCode).toBe(200);
    await first.gateway.close();

    const secondProvider = countingProvider(0);
    const second = await buildGateway(storePath, secondProvider);
    const replayed = await invoke(second.gateway, VALID_PROOF);
    expect(replayed.statusCode).toBe(409);
    expect(replayed.json().code).toBe('PAYMENT_REPLAYED');
    // Refused at the replay reservation, which runs before settle()
    expect(secondProvider.settleCalls()).toBe(0);
    await second.gateway.close();
  });

  it('rejects a malformed PAYMENT-SIGNATURE over HTTP before calling the backend', async () => {
    let backendCalls = 0;
    const provider = createX402PaymentProvider({
      network: 'eip155:84532',
      rpcUrl: 'http://127.0.0.1:8545',
      asset: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      assetName: 'MockUSDC',
      assetVersion: '2',
      assetDecimals: 6,
      payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      facilitator: {
        mode: 'local',
        signerPrivateKey: LOCAL_FACILITATOR_ACCOUNT.privateKey,
      },
    });
    const { gateway } = await buildGateway(join(dir, 'malformed-http.sqlite'), provider, () => {
      backendCalls += 1;
    });

    const response = await invoke(gateway, 'not-base64-or-json');
    expect(response.statusCode).toBe(402);
    expect(response.json().code).toBe('PAYMENT_INVALID');
    expect(backendCalls).toBe(0);
    await gateway.close();
  });
});

describe('adversarial: a facilitator that does not answer properly', () => {
  let server: Server;
  let url: string;
  let respond: (res: ServerResponse) => void;
  const facilitatorPaths: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      facilitatorPaths.push(req.url ?? '');
      respond(res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function verifyThrough(handler: (res: ServerResponse) => void): Promise<unknown> {
    respond = handler;
    const { createRemoteFacilitatorBinding } = await import('../../src/payments/x402/facilitator');
    const binding = createRemoteFacilitatorBinding({ url, auth: { type: 'none' } });
    const session = binding.open();
    try {
      // Only the transport answer is under test, not the payload shape
      const result = await session.verify({} as never, {} as never);
      return { threw: false, transportFailed: session.transportFailed(), result };
    } catch (err) {
      return { threw: true, transportFailed: session.transportFailed(), err };
    }
  }

  it('treats 401 as the facilitator failing, not the buyer', async () => {
    // A credential problem is ours and must not be recorded against the payer
    const outcome = (await verifyThrough((res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    })) as { threw: boolean; transportFailed: boolean };
    expect(outcome.threw).toBe(true);
    expect(outcome.transportFailed).toBe(true);
  });

  it('reads a 400 with an invalidReason as a verdict against the payment', async () => {
    const outcome = (await verifyThrough((res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isValid: false, invalidReason: 'insufficient_funds' }));
    })) as { threw: boolean; transportFailed: boolean; result?: unknown };
    expect(outcome).toEqual({
      threw: false,
      transportFailed: false,
      result: { isValid: false, invalidReason: 'insufficient_funds' },
    });
  });

  it('never reads a 401 as a verdict, even with a verify-shaped body', async () => {
    const outcome = (await verifyThrough((res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ isValid: false, invalidReason: 'unauthorized' }));
    })) as { threw: boolean; transportFailed: boolean };
    expect(outcome.threw).toBe(true);
    expect(outcome.transportFailed).toBe(true);
  });

  it('treats 500 as the facilitator failing', async () => {
    const outcome = (await verifyThrough((res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
    })) as { threw: boolean; transportFailed: boolean };
    expect(outcome.threw).toBe(true);
    expect(outcome.transportFailed).toBe(true);
  });

  it('refuses to read a verdict out of an unparseable 200', async () => {
    // A 200 that is not a verify response must never deliver the resource
    const outcome = (await verifyThrough((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('<html>gateway timeout</html>');
    })) as { threw: boolean; transportFailed: boolean };
    expect(outcome.threw).toBe(true);
    expect(outcome.transportFailed).toBe(true);
  });

  it('refuses a 200 whose JSON is well-formed but not a verify response', async () => {
    // Never `isValid: true` by omission, and never a verdict against the payer
    const outcome = (await verifyThrough((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ totally: 'unrelated' }));
    })) as { threw: boolean; transportFailed: boolean };
    expect(outcome.threw).toBe(true);
    expect(outcome.transportFailed).toBe(true);
  });

  describe('seen through the gateway', () => {
    let dir: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'oac-facilitator-'));
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    // The real x402 provider in remote mode, paid with a proof signed offline
    // for the gateway's own challenge, so only the facilitator's answer varies
    async function payThrough(storeName: string, handler: (res: ServerResponse) => void) {
      respond = handler;
      let backendCalls = 0;
      const provider = createX402PaymentProvider({
        network: 'eip155:84532',
        rpcUrl: 'http://127.0.0.1:8545',
        asset: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        assetName: 'MockUSDC',
        assetVersion: '2',
        assetDecimals: 6,
        payTo: '0x1111111111111111111111111111111111111111',
        facilitator: { mode: 'remote', url, auth: { type: 'none' } },
      });
      const { gateway, store } = await buildGateway(join(dir, storeName), provider, () => {
        backendCalls += 1;
      });
      try {
        const challenge = await gateway.server.inject({
          method: 'POST',
          url: `/api/resources/${RESOURCE_ID}/invoke`,
          payload: {},
        });
        const proof = await createPaymentProof({
          buyerPrivateKey: LOCAL_BUYER_ACCOUNT.privateKey,
          accepts: challenge.json().payment.accepts[0],
        });
        facilitatorPaths.length = 0;
        const response = await invoke(gateway, proof);
        return {
          status: response.statusCode,
          body: response.json(),
          facilitatorPaths: [...facilitatorPaths],
          backendCalls,
          attempts: await store.listPaymentAttempts(),
        };
      } finally {
        await gateway.close();
      }
    }

    it.each([
      { answer: '401', status: 401, body: JSON.stringify({ error: 'unauthorized' }) },
      { answer: '500', status: 500, body: JSON.stringify({ error: 'boom' }) },
      { answer: 'unparseable 200', status: 200, body: '<html>gateway timeout</html>' },
      { answer: 'non-verify 200', status: 200, body: JSON.stringify({ totally: 'unrelated' }) },
    ])(
      'answers a facilitator $answer with a retryable 503 and records nothing against the payer',
      async ({ status, body }) => {
        const outcome = await payThrough(`unavailable-${status}-${body.length}.sqlite`, (res) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(body);
        });

        expect(outcome.status).toBe(503);
        expect(outcome.body.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
        expect(outcome.body.retryable).toBe(true);
        expect(outcome.facilitatorPaths).toEqual(['/verify']);
        expect(outcome.backendCalls).toBe(0);
        expect(outcome.attempts).toEqual([]);
      },
    );

    it("answers a 400 naming an invalidReason as PAYMENT_INVALID, the buyer's verdict (control)", async () => {
      const outcome = await payThrough('verdict-400.sqlite', (res) => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ isValid: false, invalidReason: 'insufficient_funds' }));
      });

      expect(outcome.status).toBe(402);
      expect(outcome.body.code).toBe('PAYMENT_INVALID');
      expect(outcome.facilitatorPaths).toEqual(['/verify']);
      expect(outcome.backendCalls).toBe(0);
      expect(outcome.attempts).toEqual([]);
    });
  });
});
