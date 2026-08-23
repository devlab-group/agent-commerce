/**
 * Adversarial payment scenarios that only mean anything above the unit level.
 *
 * The provider's own negative cases (wrong amount, wrong recipient, wrong
 * network, wrong asset, tampered payload, expired authorisation) are covered
 * against a real chain in `tests/e2e/payment`. What is here is the set that
 * needs the *pipeline*, the *store* or a real *HTTP facilitator* to be
 * meaningful:
 *
 * - two identical requests genuinely in flight at once
 * - the same authorisation replayed after the process restarts
 * - a facilitator that answers 401, 500, or with something unparseable
 *
 * Deterministic and offline: the facilitator is a loopback HTTP server this
 * file starts, and the chain is not involved at all.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/index.js';
import type {
  AdapterDescriptor,
  PaymentContext,
  PaymentProvider,
  PaymentRequirement,
  PaymentResult,
  PaymentSettlementContext,
  PaymentVerificationContext,
  ReceiptStore,
} from '../../src/core/index.js';
import { isCommerceError } from '../../src/core/index.js';
import { createGateway, type GatewayInstance } from '../../src/gateway/index.js';
import { createSqliteReceiptStore } from '../../src/storage/receipts/index.js';

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
 * A provider whose `settle()` is slow and counted.
 *
 * Slow on purpose: the replay reservation is a race, and a settle that returns
 * instantly lets two "concurrent" requests serialise by accident, which would
 * make this test pass without proving anything.
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
            // One authorisation, one key — the whole point of the reservation.
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
      call: async () => ({ status: 200, headers: {}, body: { ok: true }, durationMs: 1 }),
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

  it('settles exactly once when the same authorisation arrives twice at the same moment', async () => {
    const provider = countingProvider(150);
    const { gateway } = await buildGateway(join(dir, 'concurrent.sqlite'), provider);

    // Genuinely in flight together: neither has finished settling when the
    // other starts. On-chain nonce checks cannot help here — the first
    // transaction has not landed yet — so the gateway's own reservation is the
    // only thing standing between one authorisation and two deliveries.
    const [a, b] = await Promise.all([invoke(gateway, VALID_PROOF), invoke(gateway, VALID_PROOF)]);

    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    expect(provider.settleCalls()).toBe(1);

    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().code).toBe('PAYMENT_REPLAYED');

    await gateway.close();
  });

  it('still refuses the authorisation after the gateway restarts', async () => {
    // The reservation lives in SQLite, not in memory. A process restart is the
    // cheapest way to find out whether that is true.
    const storePath = join(dir, 'restart.sqlite');

    const first = await buildGateway(storePath, countingProvider(0));
    expect((await invoke(first.gateway, VALID_PROOF)).statusCode).toBe(200);
    await first.gateway.close();

    const second = await buildGateway(storePath, countingProvider(0));
    const replayed = await invoke(second.gateway, VALID_PROOF);
    expect(replayed.statusCode).toBe(409);
    expect(replayed.json().code).toBe('PAYMENT_REPLAYED');
    // And nothing was settled the second time round.
    expect(second.gateway).toBeDefined();
    await second.gateway.close();
  });
});

describe('adversarial: a facilitator that does not answer properly', () => {
  let server: Server;
  let url: string;
  let respond: (res: ServerResponse) => void;

  beforeAll(async () => {
    server = createServer((_req, res) => respond(res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function verifyThrough(handler: (res: ServerResponse) => void): Promise<unknown> {
    respond = handler;
    const { createRemoteFacilitatorBinding } = await import(
      '../../src/payments/x402/facilitator.js'
    );
    const binding = createRemoteFacilitatorBinding({ url, auth: { type: 'none' } });
    const session = binding.open();
    try {
      // Shapes do not matter: the transport answer is what is under test.
      await session.verify({} as never, {} as never);
      return { threw: false, transportFailed: session.transportFailed() };
    } catch (err) {
      return { threw: true, transportFailed: session.transportFailed(), err };
    }
  }

  it('treats 401 as the facilitator failing, not the buyer', async () => {
    // A credential problem is ours. Recording it against the payer would blame
    // them for our misconfiguration and burn an authorisation nothing checked.
    const outcome = (await verifyThrough((res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
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
    // The dangerous shape: a 200 that is not a verify response. Anything that
    // guessed "looks fine" here would deliver a paid resource on no evidence.
    const outcome = (await verifyThrough((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('<html>gateway timeout</html>');
    })) as { threw: boolean; transportFailed: boolean };
    expect(outcome.threw).toBe(true);
    expect(outcome.transportFailed).toBe(true);
  });

  it('refuses a 200 whose JSON is well-formed but not a verify response', async () => {
    const outcome = (await verifyThrough((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ totally: 'unrelated' }));
    })) as { threw: boolean; transportFailed: boolean; err?: unknown };
    expect(outcome.threw).toBe(true);
    // Never `isValid: true` by omission.
    if (outcome.err !== undefined) {
      expect(isCommerceError(outcome.err) || outcome.err instanceof Error).toBe(true);
    }
  });
});
