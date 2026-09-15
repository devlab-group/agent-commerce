/**
 * Every AP2 refusal the gateway has to make, driven end to end.
 *
 * Only the payment rail is doubled, and it counts calls: what every case has
 * to prove is that settlement was never reached. The config, the provider and
 * the signing are the shipped ones. Settlement behind a mandate is
 * `tests/e2e/authorization`.
 *
 * FIXTURE PROVENANCE: mandates are minted to the AP2 v0.2.0 shape (tagged
 * 2026-04-28, commit b4587ac), not upstream golden vectors. See fixtures.ts.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AP2_CHECKOUT_PROFILE } from '../../src/authorization/ap2/constants.js';
import { createAp2AuthorizationProvider } from '../../src/authorization/ap2/index.js';
import { computeInputHash } from '../../src/authorization/ap2/profile.js';
import { type GatewayConfig, parseConfig } from '../../src/config/index.js';
import type {
  AdapterDescriptor,
  AuthorizationProvider,
  BackendExecutor,
  PaymentProvider,
  PaymentRequirement,
  PaymentResult,
  ReceiptStore,
} from '../../src/core/index.js';
import { AUTHORIZATION_HEADER, CommerceError, PAYMENT_HEADER } from '../../src/core/index.js';
import { createGateway, type GatewayInstance } from '../../src/gateway/index.js';
import { createSqliteReceiptStore } from '../../src/storage/receipts/index.js';
import {
  checkoutPayload,
  createParties,
  fixedClock,
  type MandateOptions,
  mintMandate,
  NOW_SECONDS,
  type Party,
  sha256Base64url,
  signCheckoutJwt,
} from '../unit/authorization-ap2/fixtures.js';

process.env['NODE_ENV'] = 'test';

const RESOURCE_ID = 'market_report';
const INPUT = { city: 'Berlin' };
const MERCHANT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const ASSET = '0x1111111111111111111111111111111111111111';
const NETWORK = 'eip155:84532';
const PROOF = 'x402-proof-1';

let parties: Party;
let config: GatewayConfig;
let inputHash: string;

let gateway: GatewayInstance | undefined;
let store: ReceiptStore | undefined;
let authorization: (AuthorizationProvider & { close(): void }) | undefined;

interface Counters {
  verify: number;
  settle: number;
  backend: number;
}
let counts: Counters;

// --- the rail ---------------------------------------------------------------

const descriptor: AdapterDescriptor = {
  name: 'x402',
  kind: 'payment',
  implementationVersion: '0.0.0-test',
  supportedSpec: 'x402/v2 scheme=exact family=eip155',
  capabilities: [],
  status: 'stable',
};

interface RailOptions {
  readonly verify?: () => Promise<PaymentResult>;
  readonly settle?: () => Promise<PaymentResult>;
}

// Counts what it was asked to do. Its requirement carries the chain
// coordinates a real x402 challenge does, which the mandate must agree with
function countingRail(options: RailOptions = {}): PaymentProvider {
  const settled: PaymentResult = {
    status: 'settled',
    provider: 'x402',
    amount: '0.01',
    currency: 'USDC',
    payer: '0xBUYER',
    payee: MERCHANT,
    network: NETWORK,
    externalReference: '0xtx',
  };
  return {
    name: 'x402',
    descriptor,
    async createRequirement(ctx): Promise<PaymentRequirement> {
      return {
        id: 'requirement-1',
        requestId: ctx.requestId,
        resourceId: ctx.resource.id,
        provider: 'x402',
        amount: ctx.amount,
        currency: ctx.currency,
        destination: MERCHANT,
        network: NETWORK,
        asset: ASSET,
        challenge: { provider: 'x402', version: '2', accepts: [{ scheme: 'exact' }] },
      };
    },
    async verify() {
      counts.verify += 1;
      if (options.verify) return options.verify();
      return {
        status: 'verified',
        provider: 'x402',
        amount: '0.01',
        currency: 'USDC',
        payer: '0xBUYER',
        payee: MERCHANT,
        replayKey: `replay-${counts.verify}`,
      };
    },
    async settle() {
      counts.settle += 1;
      if (options.settle) return options.settle();
      return settled;
    },
    async health() {
      return { status: 'pass', checkedAt: '2026-01-01T00:00:00.000Z' };
    },
  };
}

const backend: BackendExecutor = {
  async call() {
    counts.backend += 1;
    return { status: 200, body: { report: 'ok' }, headers: {}, durationMs: 1 };
  },
};

// --- config -----------------------------------------------------------------

function rawConfig(): Record<string, unknown> {
  const issuer = (entry: { issuer: string; audience: string; kid: string; jwk: unknown }) => ({
    issuer: entry.issuer,
    audience: entry.audience,
    keys: [{ kid: entry.kid, jwk: entry.jwk }],
  });
  return {
    version: 1,
    merchant: { id: 'conformance', name: 'Conformance', publicBaseUrl: 'http://127.0.0.1:8080' },
    server: { port: 8080, host: '127.0.0.1', allowedOrigins: [] },
    storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
    protocols: {
      http: { enabled: true },
      mcp: { enabled: false, mountPath: '/mcp' },
    },
    resources: {
      [RESOURCE_ID]: {
        name: 'Market report',
        input: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          // Closed: a reserved field that survived extraction would fail here
          additionalProperties: false,
        },
        backend: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
        pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
        expose: ['http'],
        payments: ['x402'],
        authorization: { required: ['ap2'] },
      },
    },
    payments: {
      x402: {
        enabled: true,
        network: NETWORK,
        rpcUrl: 'http://127.0.0.1:8545',
        asset: ASSET,
        assetName: 'MockUSDC',
        assetVersion: '2',
        assetDecimals: 6,
        payTo: MERCHANT,
        maxTimeoutSeconds: 120,
        // Never used: the rail below is a counting double, and no chain is
        // reached. It is here so the config is the one a real deployment writes
        facilitator: { mode: 'local', signerPrivateKey: '0xKEY' },
      },
    },
    authorization: {
      ap2: {
        enabled: true,
        specVersion: '0.2.0',
        mode: 'direct',
        trust: {
          mandateIssuers: parties.mandateIssuers.map((entry) =>
            issuer({
              issuer: entry.issuer,
              audience: entry.audience,
              kid: entry.keys[0]?.kid ?? '',
              jwk: entry.keys[0]?.jwk,
            }),
          ),
          checkoutIssuers: parties.checkoutIssuers.map((entry) =>
            issuer({
              issuer: entry.issuer,
              audience: entry.audience,
              kid: entry.keys[0]?.kid ?? '',
              jwk: entry.keys[0]?.jwk,
            }),
          ),
        },
        clockSkewSeconds: 60,
        replay: { path: ':memory:' },
      },
    },
  };
}

// --- mandates ---------------------------------------------------------------

// The profile a correctly minted mandate carries for this exact purchase
function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    profile: AP2_CHECKOUT_PROFILE,
    resource_id: RESOURCE_ID,
    input_hash: inputHash,
    amount: '0.01',
    currency: 'USDC',
    payment_method: 'x402',
    destination: MERCHANT,
    network: NETWORK,
    asset: ASSET,
    ...overrides,
  };
}

interface MandateSpec {
  readonly profile?: Record<string, unknown>;
  readonly checkout?: Record<string, unknown>;
  readonly mandate?: MandateOptions;
  // Signs the mandate with a key nobody trusts
  readonly stranger?: boolean;
}

async function mandate(spec: MandateSpec = {}): Promise<string> {
  const jwt = await signCheckoutJwt(
    parties.checkoutSigner,
    checkoutPayload({ agent_commerce: profile(spec.profile), ...spec.checkout }),
  );
  return mintMandate(
    spec.stranger === true ? parties.stranger : parties.mandateSigner,
    jwt,
    spec.mandate ?? {},
  );
}

function carrier(presentation: string): string {
  return Buffer.from(JSON.stringify({ method: 'ap2', payload: presentation }), 'utf8').toString(
    'base64url',
  );
}

// --- harness ----------------------------------------------------------------

type Ap2Provider = AuthorizationProvider & { close(): void };

async function startGateway(
  rail: PaymentProvider = countingRail(),
  // Wraps the real provider, for the cases that need one of its calls to fail
  wrap: (real: Ap2Provider) => AuthorizationProvider = (real) => real,
): Promise<GatewayInstance> {
  counts = { verify: 0, settle: 0, backend: 0 };
  store = createSqliteReceiptStore({ path: ':memory:' });
  await store.init();
  const ap2Config = config.authorization?.ap2;
  if (ap2Config === undefined || !ap2Config.enabled) {
    throw new Error('the fixture config must enable AP2');
  }
  authorization = createAp2AuthorizationProvider({ config: ap2Config, clock: fixedClock() });
  gateway = await createGateway({
    config,
    store,
    paymentProviders: [rail],
    authorizationProviders: [wrap(authorization)],
    protocolAdapters: [],
    backend,
  });
  return gateway;
}

interface Invocation {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

async function invoke(
  gw: GatewayInstance,
  options: { proof?: string; presentation?: string; input?: Record<string, unknown> } = {},
): Promise<Invocation> {
  const res = await gw.server.inject({
    method: 'POST',
    url: `/api/resources/${RESOURCE_ID}/invoke`,
    headers: {
      'content-type': 'application/json',
      ...(options.proof !== undefined ? { [PAYMENT_HEADER]: options.proof } : {}),
      ...(options.presentation !== undefined
        ? { [AUTHORIZATION_HEADER]: carrier(options.presentation) }
        : {}),
    },
    payload: options.input ?? INPUT,
  });
  return { statusCode: res.statusCode, body: res.json<Record<string, unknown>>() };
}

// A purchase with a real payment proof and whatever mandate the case supplies
async function purchase(presentation: string, gw = gateway): Promise<Invocation> {
  return invoke(gw as GatewayInstance, { proof: PROOF, presentation });
}

beforeAll(async () => {
  parties = await createParties();
  config = parseConfig(rawConfig(), process.env);
  inputHash = await computeInputHash(INPUT);
});

afterEach(async () => {
  await gateway?.close().catch(() => {});
  authorization?.close();
  await store?.close().catch(() => {});
  gateway = undefined;
  authorization = undefined;
  store = undefined;
});

describe('AP2 over x402: the purchase that works', () => {
  it('challenges, verifies, settles once, consumes, delivers once', async () => {
    const gw = await startGateway();

    const challenge = await invoke(gw);
    expect(challenge.statusCode).toBe(402);
    expect(challenge.body['authorization']).toEqual({
      required: [{ method: 'ap2', version: '0.2.0', profile: AP2_CHECKOUT_PROFILE }],
    });
    expect(counts.settle).toBe(0);

    const delivered = await purchase(await mandate());

    expect(delivered.statusCode).toBe(200);
    expect(counts).toEqual({ verify: 1, settle: 1, backend: 1 });
  });

  it('records the mandate as a digest and stores no part of the presentation', async () => {
    await startGateway();
    const presentation = await mandate();

    await purchase(presentation);

    const receipts = await (store as ReceiptStore).listReceipts({ limit: 10 });
    const receipt = receipts[0];
    expect(receipt?.authorization?.method).toBe('ap2');
    expect(receipt?.authorization?.reference).toMatch(/^sha256:[\w-]+$/);

    // Every segment of the presentation, not just the whole string: a stored
    // disclosure alone would still leak the buyer's purchase
    const persisted = JSON.stringify(receipts);
    for (const segment of presentation.split('~').filter((part) => part.length > 0)) {
      expect(persisted).not.toContain(segment);
    }
  });

  it('emits the authorization in the audit trail alongside the payment', async () => {
    await startGateway();

    await purchase(await mandate());

    const events = await (store as ReceiptStore).listEvents({ limit: 20 });
    const types = events.map((event) => event.type);
    expect(types).toContain('authorization.verified');
    expect(types).toContain('payment.settled');
    expect(types).toContain('resource.delivered');
  });
});

describe('AP2 over x402: mandates that must not settle', () => {
  // Every case here asserts the same thing: no money moved, nothing delivered
  async function refuse(
    presentation: string,
    expected: { status: number; code: string },
  ): Promise<void> {
    const gw = await startGateway();

    const result = await purchase(presentation, gw);

    expect(result.statusCode).toBe(expected.status);
    expect(result.body['code']).toBe(expected.code);
    expect(counts.settle).toBe(0);
    expect(counts.backend).toBe(0);
  }

  const invalid = { status: 403, code: 'AUTHORIZATION_INVALID' } as const;

  it('refuses an altered mandate', async () => {
    const original = await mandate();
    const [token, ...rest] = original.split('~');
    const [header, payload, signature] = (token as string).split('.');
    // A flipped bit in the signature's first byte, not the last base64url
    // character: that one has four meaningful bits in an 86-character ES256
    // signature, so A/B/C/D all decode alike and nothing would change.
    const bytes = Buffer.from(signature as string, 'base64url');
    bytes[0] = (bytes[0] as number) ^ 0x01;
    const forged = `${header}.${payload}.${bytes.toString('base64url')}`;
    await refuse([forged, ...rest].join('~'), invalid);
  });

  it('refuses an expired mandate', async () => {
    await refuse(
      await mandate({
        mandate: { payloadOverrides: { iat: NOW_SECONDS - 7200, exp: NOW_SECONDS - 3600 } },
      }),
      invalid,
    );
  });

  it('refuses a mandate from an untrusted issuer', async () => {
    await refuse(
      await mandate({ mandate: { payloadOverrides: { iss: 'https://evil.example' } } }),
      invalid,
    );
  });

  it('refuses a mandate that claims a trusted kid but was signed with another key', async () => {
    // The attack `kid` exists to stop: a trusted issuer, a trusted key id, and
    // a real signature from a key nobody trusts. Refused at the signature, so
    // `kid` selects the verifying key rather than labelling it.
    await refuse(
      await mandate({ stranger: true, mandate: { header: { kid: parties.mandateSigner.kid } } }),
      invalid,
    );
  });

  it('refuses a mandate naming a kid the issuer does not have', async () => {
    await refuse(await mandate({ mandate: { header: { kid: 'rotated-out-2025' } } }), invalid);
  });

  it('refuses a mandate whose checkout_hash does not match the disclosed checkout', async () => {
    await refuse(
      await mandate({
        mandate: { payloadOverrides: { checkout_hash: await sha256Base64url('another-document') } },
      }),
      invalid,
    );
  });

  it('refuses a mandate approved for a different resource', async () => {
    await refuse(await mandate({ profile: { resource_id: 'other_report' } }), invalid);
  });

  it('refuses a mandate approved for different input', async () => {
    await refuse(
      await mandate({ profile: { input_hash: await computeInputHash({ city: 'Paris' }) } }),
      invalid,
    );
  });

  it('refuses a mandate approved for a different amount', async () => {
    await refuse(await mandate({ profile: { amount: '500.00' } }), invalid);
  });

  it('refuses a mandate approved in a different currency', async () => {
    await refuse(await mandate({ profile: { currency: 'EURC' } }), invalid);
  });

  it('refuses a mandate approved for a different payment method', async () => {
    await refuse(await mandate({ profile: { payment_method: 'acp' } }), invalid);
  });

  it('refuses a mandate approved for a different network', async () => {
    await refuse(await mandate({ profile: { network: 'eip155:8453' } }), invalid);
  });

  it('refuses a mandate approved for a different asset', async () => {
    await refuse(
      await mandate({ profile: { asset: '0x2222222222222222222222222222222222222222' } }),
      invalid,
    );
  });

  it('refuses a mandate silent about the chain the requirement names', async () => {
    // Fail closed both ways: a mandate that never mentioned a chain must not
    // unlock a settlement on one. `undefined` is dropped when the JWT is
    // serialised, so these two claims are genuinely absent.
    await refuse(await mandate({ profile: { network: undefined, asset: undefined } }), invalid);
  });

  it('refuses a replayed mandate as replayed, not as invalid', async () => {
    const gw = await startGateway();
    const presentation = await mandate();

    const first = await purchase(presentation, gw);
    const second = await purchase(presentation, gw);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(second.body['code']).toBe('AUTHORIZATION_REPLAYED');
    // The first purchase settled; the replay did not
    expect(counts.settle).toBe(1);
    expect(counts.backend).toBe(1);
  });
});

describe('AP2 over x402: when settlement goes wrong', () => {
  it('reports a verifier outage as unavailable and retryable, never as a payment failure', async () => {
    const gw = await startGateway(countingRail(), (real) => ({
      ...real,
      // Our store is what broke, not the buyer's mandate
      async verifyAndReserve() {
        throw new CommerceError('AUTHORIZATION_PROVIDER_UNAVAILABLE', 'store down');
      },
    }));

    const result = await purchase(await mandate(), gw);

    expect(result.statusCode).toBe(503);
    expect(result.body['code']).toBe('AUTHORIZATION_PROVIDER_UNAVAILABLE');
    expect(result.body['retryable']).toBe(true);
    expect(counts.settle).toBe(0);
  });

  it('lets a corrected payment proof retry with the same still-valid mandate', async () => {
    let attempt = 0;
    const gw = await startGateway(
      countingRail({
        // First proof is rejected, the second verifies
        verify: async () => {
          attempt += 1;
          return attempt === 1
            ? {
                status: 'rejected',
                provider: 'x402',
                amount: '0.01',
                currency: 'USDC',
                rejectionReason: 'signature does not match payer',
              }
            : {
                status: 'verified',
                provider: 'x402',
                amount: '0.01',
                currency: 'USDC',
                replayKey: 'replay-2',
              };
        },
      }),
    );
    const presentation = await mandate();

    const rejected = await purchase(presentation, gw);
    expect(rejected.statusCode).toBe(402);
    expect(rejected.body['code']).toBe('PAYMENT_INVALID');

    const delivered = await purchase(presentation, gw);
    expect(delivered.statusCode).toBe(200);
    expect(counts.settle).toBe(1);
  });

  it('hands the mandate back when settlement is definitively refused', async () => {
    let attempt = 0;
    const gw = await startGateway(
      countingRail({
        settle: async () => {
          attempt += 1;
          return attempt === 1
            ? {
                status: 'rejected',
                provider: 'x402',
                amount: '0.01',
                currency: 'USDC',
                rejectionReason: 'insufficient balance',
              }
            : {
                status: 'settled',
                provider: 'x402',
                amount: '0.01',
                currency: 'USDC',
                externalReference: '0xtx',
              };
        },
      }),
    );
    const presentation = await mandate();

    const failed = await purchase(presentation, gw);
    expect(failed.statusCode).toBe(502);
    expect(failed.body['code']).toBe('PAYMENT_SETTLEMENT_FAILED');

    // The reservation was released, so the buyer's own mandate is still theirs
    const delivered = await purchase(presentation, gw);
    expect(delivered.statusCode).toBe(200);
    expect(counts.backend).toBe(1);
  });

  it('does not hand the mandate back when a broadcast settlement was never confirmed', async () => {
    const gw = await startGateway(
      countingRail({
        settle: async () => {
          throw new CommerceError('PAYMENT_PROVIDER_UNAVAILABLE', 'confirmation timed out', {
            details: { transactionHash: '0xabc' },
          });
        },
      }),
    );
    const presentation = await mandate();

    const uncertain = await purchase(presentation, gw);
    expect(uncertain.statusCode).toBe(502);
    expect(uncertain.body['code']).toBe('PAYMENT_SETTLEMENT_FAILED');

    // The buyer's funds may already have moved, so the mandate is not reusable
    const retry = await purchase(presentation, gw);
    expect(retry.statusCode).toBe(409);
    expect(retry.body['code']).toBe('AUTHORIZATION_REPLAYED');
    expect(counts.backend).toBe(0);
  });
});
