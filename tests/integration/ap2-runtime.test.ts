/**
 * AP2 as a wired subsystem, through the real gateway.
 *
 * What a mandate must contain is settled elsewhere. These own the wiring: that
 * enabling AP2 changes only the resources that ask for it, that a gated
 * purchase advertises what it needs, and that a broken verifier degrades those
 * resources without taking the rest of the gateway down with them.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AP2_CHECKOUT_PROFILE } from '../../src/authorization/ap2/constants.js';
import { createAp2AuthorizationProvider } from '../../src/authorization/ap2/index.js';
import { computeInputHash } from '../../src/authorization/ap2/profile.js';
import type { Ap2ReplayStore } from '../../src/authorization/ap2/replay-store.js';
import type { EnabledAp2Config } from '../../src/authorization/ap2/types.js';
import type { GatewayConfig } from '../../src/config/index.js';
import type { AuthorizationProvider, BackendExecutor } from '../../src/core/index.js';
import { AUTHORIZATION_HEADER } from '../../src/core/index.js';
import { createGateway, type GatewayInstance } from '../../src/gateway/index.js';
import {
  checkoutPayload,
  createParties,
  fixedClock,
  mintMandate,
  type Party,
  signCheckoutJwt,
} from '../unit/authorization-ap2/fixtures.js';
import { createFakePaymentProvider, createFakeStore } from '../unit/gateway/helpers.js';

process.env['NODE_ENV'] = 'test';

let parties: Party;
let gateway: GatewayInstance | undefined;
let provider: { close(): void } | undefined;

beforeAll(async () => {
  parties = await createParties();
});

afterEach(async () => {
  await gateway?.close().catch(() => {});
  provider?.close();
  gateway = undefined;
  provider = undefined;
});

const backend: BackendExecutor = {
  async call() {
    return { status: 200, body: { forecast: 'sunny' }, headers: {}, durationMs: 1 };
  },
};

function ap2Config(): EnabledAp2Config {
  return {
    enabled: true,
    specVersion: '0.2.0',
    mode: 'direct',
    trust: { mandateIssuers: parties.mandateIssuers, checkoutIssuers: parties.checkoutIssuers },
    clockSkewSeconds: 60,
    replay: { path: ':memory:' },
  };
}

/**
 * Three resources: one gated by AP2, one paid but ungated, one free. The
 * second and third are what proves enabling AP2 is not a gateway-wide switch.
 */
function config(): GatewayConfig {
  return {
    version: 1,
    merchant: { id: 'demo-store', name: 'Demo Store', publicBaseUrl: 'http://localhost:8080' },
    server: { port: 0, host: '127.0.0.1', allowedOrigins: [] },
    storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
    protocols: {
      http: { enabled: true },
      mcp: { enabled: false, mountPath: '/mcp' },
      a2a: { enabled: false, mountPath: '/a2a' },
      acp: { enabled: false, mountPath: '/acp' },
    },
    resources: [
      {
        id: 'gated_report',
        name: 'Gated Report',
        handler: { type: 'http', method: 'GET', url: 'http://backend.local/report' },
        pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
        exposedVia: ['http'],
        paymentMethods: ['x402'],
        authorization: { required: ['ap2'] },
      },
      {
        id: 'paid_report',
        name: 'Paid Report',
        handler: { type: 'http', method: 'GET', url: 'http://backend.local/report' },
        pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
        exposedVia: ['http'],
        paymentMethods: ['x402'],
      },
      {
        id: 'free_report',
        name: 'Free Report',
        handler: { type: 'http', method: 'GET', url: 'http://backend.local/report' },
        pricing: { type: 'free' },
        exposedVia: ['http'],
        paymentMethods: [],
      },
    ],
    payments: {},
  };
}

async function startGateway(
  authorizationProviders: readonly AuthorizationProvider[],
): Promise<GatewayInstance> {
  gateway = await createGateway({
    config: config(),
    store: createFakeStore(),
    paymentProviders: [createFakePaymentProvider()],
    authorizationProviders,
    protocolAdapters: [],
    backend,
  });
  return gateway;
}

function startAp2(replayStore?: Ap2ReplayStore): AuthorizationProvider {
  const created = createAp2AuthorizationProvider({
    config: ap2Config(),
    clock: fixedClock(),
    ...(replayStore !== undefined ? { replayStore } : {}),
  });
  provider = created;
  return created;
}

async function invoke(
  gw: GatewayInstance,
  resourceId: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await gw.server.inject({
    method: 'POST',
    url: `/api/resources/${resourceId}/invoke`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: {},
  });
  return { statusCode: res.statusCode, body: res.json<Record<string, unknown>>() };
}

function encodeCarrier(payload: string): string {
  return Buffer.from(JSON.stringify({ method: 'ap2', payload }), 'utf8').toString('base64url');
}

/**
 * A mandate that authorizes exactly what `createFakePaymentProvider` requires
 * of `gated_report`, so a refusal can only come from the wiring under test.
 */
async function validCarrier(): Promise<string> {
  const jwt = await signCheckoutJwt(
    parties.checkoutSigner,
    checkoutPayload({
      agent_commerce: {
        profile: AP2_CHECKOUT_PROFILE,
        resource_id: 'gated_report',
        input_hash: await computeInputHash({}),
        amount: '0.01',
        currency: 'USDC',
        payment_method: 'x402',
        destination: '0xMERCHANT',
      },
    }),
  );
  return encodeCarrier(await mintMandate(parties.mandateSigner, jwt));
}

describe('AP2 wired into the gateway', () => {
  it('advertises the mandate a gated resource needs alongside its 402 challenge', async () => {
    const gw = await startGateway([startAp2()]);

    const { statusCode, body } = await invoke(gw, 'gated_report');

    expect(statusCode).toBe(402);
    expect(body['authorization']).toEqual({
      required: [{ method: 'ap2', version: '0.2.0', profile: 'agent-commerce/ap2/checkout/v1' }],
    });
  });

  it('leaves the challenge for an ungated paid resource untouched', async () => {
    const gw = await startGateway([startAp2()]);

    const { statusCode, body } = await invoke(gw, 'paid_report');

    expect(statusCode).toBe(402);
    expect(body['authorization']).toBeUndefined();
  });

  it('serves a free resource with AP2 enabled exactly as before', async () => {
    const gw = await startGateway([startAp2()]);

    const { statusCode } = await invoke(gw, 'free_report');

    expect(statusCode).toBe(200);
  });

  it('refuses a gated purchase whose proof is missing, with a payment proof present', async () => {
    const gw = await startGateway([startAp2()]);

    const { statusCode, body } = await invoke(gw, 'gated_report', {
      'payment-signature': 'x402-proof',
    });

    expect(statusCode).toBe(403);
    expect(body['code']).toBe('AUTHORIZATION_REQUIRED');
  });

  it('delivers a gated purchase and records the mandate digest on the receipt', async () => {
    const store = createFakeStore();
    gateway = await createGateway({
      config: config(),
      store,
      paymentProviders: [createFakePaymentProvider()],
      authorizationProviders: [startAp2()],
      protocolAdapters: [],
      backend,
    });

    const { statusCode } = await invoke(gateway, 'gated_report', {
      'payment-signature': 'x402-proof',
      [AUTHORIZATION_HEADER]: await validCarrier(),
    });

    expect(statusCode).toBe(200);
    const receipt = store.receipts[0];
    expect(receipt?.authorization?.method).toBe('ap2');
    expect(receipt?.authorization?.reference).toMatch(/^sha256:[\w-]+$/);
    // The proof itself never reaches the record
    expect(JSON.stringify(receipt)).not.toContain('eyJ');
  });

  it('refuses a proof that is not a mandate as invalid, never as a payment failure', async () => {
    const gw = await startGateway([startAp2()]);

    const { statusCode, body } = await invoke(gw, 'gated_report', {
      'payment-signature': 'x402-proof',
      [AUTHORIZATION_HEADER]: encodeCarrier('not-a-mandate'),
    });

    expect(statusCode).toBe(403);
    expect(body['code']).toBe('AUTHORIZATION_INVALID');
  });

  describe('a verifier whose store is broken', () => {
    const brokenStore = (): Ap2ReplayStore => {
      const boom = (): never => {
        throw new Error('sqlite: disk I/O error');
      };
      return {
        reserve: boom,
        consume: boom,
        release: boom,
        markUncertain: boom,
        stateOf: boom,
        close: () => {},
      };
    };

    it('reports a good mandate it cannot record as unavailable, not as a bad mandate', async () => {
      const gw = await startGateway([startAp2(brokenStore())]);

      const { statusCode, body } = await invoke(gw, 'gated_report', {
        'payment-signature': 'x402-proof',
        [AUTHORIZATION_HEADER]: await validCarrier(),
      });

      // 503 and retryable: the mandate verified, and our store is what failed
      expect(statusCode).toBe(503);
      expect(body['code']).toBe('AUTHORIZATION_PROVIDER_UNAVAILABLE');
      expect(body['retryable']).toBe(true);
    });

    it('keeps serving every resource that does not require a mandate', async () => {
      const gw = await startGateway([startAp2(brokenStore())]);

      expect((await invoke(gw, 'free_report')).statusCode).toBe(200);
      expect((await invoke(gw, 'paid_report')).statusCode).toBe(402);
    });

    it('blocks readiness, since a gated purchase cannot be honoured', async () => {
      const gw = await startGateway([startAp2(brokenStore())]);

      const res = await gw.server.inject({ method: 'GET', url: '/ready' });
      const body = res.json<{
        ready: boolean;
        authorizationProviders: { name: string; status: string; detail?: string }[];
      }>();

      expect(res.statusCode).toBe(503);
      expect(body.ready).toBe(false);
      expect(body.authorizationProviders).toEqual([
        { name: 'ap2', status: 'fail', detail: 'authorization-provider-unreachable' },
      ]);
      // A fixed vocabulary token: `/ready` is unauthenticated
      expect(JSON.stringify(body)).not.toContain('disk I/O');
    });
  });

  it('reports a healthy provider on /ready without naming a key', async () => {
    const gw = await startGateway([startAp2()]);

    const res = await gw.server.inject({ method: 'GET', url: '/ready' });
    const body = res.json<{ ready: boolean; authorizationProviders: { status: string }[] }>();

    expect(res.statusCode).toBe(200);
    expect(body.ready).toBe(true);
    expect(body.authorizationProviders).toEqual([{ name: 'ap2', status: 'pass' }]);
    expect(JSON.stringify(body)).not.toContain(parties.mandateSigner.publicJwk['x']);
  });

  it('runs with no authorization provider at all, which is the default', async () => {
    const gw = await startGateway([]);

    const res = await gw.server.inject({ method: 'GET', url: '/ready' });
    const body = res.json<{ ready: boolean; authorizationProviders: unknown[] }>();

    expect(body.ready).toBe(true);
    expect(body.authorizationProviders).toEqual([]);
    // The resource still declares `authorization.required`, and with no
    // provider to check it the pipeline refuses rather than serving it
    // A misconfigured gateway is our fault, not the caller's, so 500
    const { statusCode, body: invoked } = await invoke(gw, 'gated_report');
    expect(statusCode).toBe(500);
    expect(invoked['code']).toBe('CONFIG_INVALID');
  });
});
