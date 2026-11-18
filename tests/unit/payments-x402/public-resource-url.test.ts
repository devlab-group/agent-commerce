// Public `resource.url` selection, offer matching and URL mismatch refusals
import { x402Client } from '@x402/core/client';
import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CommerceResource,
  PaymentContext,
  PaymentRequirement,
  ProtocolName,
} from '../../../src/core';
import {
  createX402PaymentProvider,
  type X402ProviderOptions,
} from '../../../src/payments/x402/provider';

const verifyMock = vi.fn();

// Local proof validation runs before the mocked facilitator HTTP client
vi.mock('@x402/core/http', () => ({
  FacilitatorResponseError: class extends Error {},
  HTTPFacilitatorClient: class {
    verify(...args: unknown[]) {
      return verifyMock(...args);
    }
  },
}));

const ASSET = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const PAY_TO = '0x1111111111111111111111111111111111111111';
const OTHER_ASSET = '0x2222222222222222222222222222222222222222';
const OTHER_PAY_TO = '0x3333333333333333333333333333333333333333';
const BUYER = privateKeyToAccount(
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
);
const BASE = 'https://shop.example';
const URLS = {
  'demo.report': {
    http: `${BASE}/api/resources/demo.report/invoke`,
    mcp: `${BASE}/mcp`,
    a2a: `${BASE}/a2a`,
  },
};
const SINGLE_RESOURCE_URL = `resource://agent-commerce/eip155%3A31337/${PAY_TO}/resources/demo.report`;
const SHARED_RESOURCE_URL = 'resource://agent-commerce/resources/demo.report';

const RESOURCE: CommerceResource = {
  id: 'demo.report',
  name: 'Demo report',
  handler: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
  pricing: { type: 'fixed', amount: '0.01', currency: 'USD' },
  exposedVia: ['http', 'mcp', 'a2a'],
  paymentMethods: ['x402'],
};

const offer = (asset: string, payTo: string) => ({
  network: 'eip155:31337',
  rpcUrl: 'http://127.0.0.1:19321', // never contacted
  asset,
  assetName: 'MockUSDC',
  assetVersion: '2',
  assetDecimals: 6,
  payTo,
});

function provider(offers: 1 | 2, resourceUrls?: X402ProviderOptions['resourceUrls']) {
  return createX402PaymentProvider({
    offers:
      offers === 1
        ? [offer(ASSET, PAY_TO)]
        : [offer(ASSET, PAY_TO), offer(OTHER_ASSET, OTHER_PAY_TO)],
    facilitator: { mode: 'remote', url: 'https://facilitator.example', auth: { type: 'none' } },
    ...(resourceUrls !== undefined ? { resourceUrls } : {}),
  });
}

function context(protocol?: ProtocolName): PaymentContext {
  return {
    requestId: 'req-1',
    resource: RESOURCE,
    amount: '0.01',
    currency: 'USD',
    requestedAt: '2026-11-18T00:00:00.000Z',
    ...(protocol !== undefined ? { protocol } : {}),
  };
}

const urlOf = (requirement: PaymentRequirement) =>
  (requirement.challenge.envelope as unknown as PaymentRequired).resource.url;

// The SDK client signs the offer at `pick` and echoes the challenge's resource
async function sdkProof(challenge: PaymentRequirement, pick = 0): Promise<PaymentPayload> {
  const client = new x402Client((_version, accepts) => accepts[pick] as never);
  registerExactEvmScheme(client, { signer: BUYER, networks: ['eip155:31337'] });
  client.setSpendControls(false); // the test token is not in the SDK's list
  return client.createPaymentPayload(challenge.challenge.envelope as unknown as PaymentRequired);
}

// Selects the offer as the pipeline does, then verifies against it
async function verify(
  by: ReturnType<typeof provider>,
  requirement: PaymentRequirement,
  payload: PaymentPayload,
) {
  const ctx = {
    requestId: 'req-1',
    resource: RESOURCE,
    requirement,
    submission: {
      method: 'x402' as const,
      payload: Buffer.from(JSON.stringify(payload)).toString('base64'),
    },
  };
  const selected = (await by.selectRequirement?.(ctx)) ?? requirement;
  return { selected, result: await by.verify({ ...ctx, requirement: selected }) };
}

beforeEach(() => {
  verifyMock.mockReset().mockResolvedValue({ isValid: true, payer: BUYER.address });
});

describe('x402 public resource URL: the challenge', () => {
  it.each([
    ['http', 1],
    ['mcp', 1],
    ['a2a', 1],
    ['http', 2],
    ['mcp', 2],
    ['a2a', 2],
  ] as const)('names the %s endpoint with %i offer(s)', async (protocol, offers) => {
    const requirement = await provider(offers, URLS).createRequirement(context(protocol));
    expect(urlOf(requirement)).toBe(URLS['demo.report'][protocol]);
  });

  it.each([
    ['no surface', 1, undefined, SINGLE_RESOURCE_URL],
    ['an ACP request', 1, 'acp', SINGLE_RESOURCE_URL],
    ['no surface', 2, undefined, SHARED_RESOURCE_URL],
    ['an ACP request', 2, 'acp', SHARED_RESOURCE_URL],
  ] as const)(
    'keeps the resource:// form for %s with %i offer(s)',
    async (_label, offers, protocol, url) => {
      const requirement = await provider(offers, URLS).createRequirement(context(protocol));
      expect(urlOf(requirement)).toBe(url);
    },
  );

  it('keeps the resource:// form for a surface the map gives no URL', async () => {
    const only = { 'demo.report': { http: URLS['demo.report'].http } };
    expect(urlOf(await provider(1, only).createRequirement(context('mcp')))).toBe(
      SINGLE_RESOURCE_URL,
    );
  });

  it.each(['http', 'mcp', 'a2a'] as const)(
    'is unchanged without the option on the %s surface',
    async (protocol) => {
      expect(urlOf(await provider(1).createRequirement(context(protocol)))).toBe(
        SINGLE_RESOURCE_URL,
      );
      expect(urlOf(await provider(2).createRequirement(context(protocol)))).toBe(
        SHARED_RESOURCE_URL,
      );
    },
  );
});

describe('x402 public resource URL: proofs', () => {
  it.each([
    [1, 0, PAY_TO],
    [2, 0, PAY_TO],
    [2, 1, OTHER_PAY_TO],
  ] as const)(
    'verifies an SDK proof echoing the URL, with %i offer(s), for the offer at %i',
    async (offers, pick, payTo) => {
      const by = provider(offers, URLS);
      const challenge = await by.createRequirement(context('http'));
      const payload = await sdkProof(challenge, pick);
      expect(payload.resource?.url).toBe(URLS['demo.report'].http);

      const { selected, result } = await verify(by, challenge, payload);
      expect(selected.destination).toBe(payTo);
      expect(result.status).toBe('verified');
      expect(verifyMock).toHaveBeenCalledTimes(1);
    },
  );

  // Verify each proof against the requirement for the request carrying it
  const REFUSED: ReadonlyArray<
    readonly [string, (offers: 1 | 2) => Promise<[PaymentRequirement, PaymentPayload]>]
  > = [
    [
      'an echoed URL the challenge did not name',
      async (offers) => {
        const challenge = await provider(offers, URLS).createRequirement(context('http'));
        const payload = await sdkProof(challenge);
        return [challenge, { ...payload, resource: { ...payload.resource, url: `${BASE}/other` } }];
      },
    ],
    [
      'a proof for the HTTP challenge paid on MCP',
      async (offers) => {
        const by = provider(offers, URLS);
        const payload = await sdkProof(await by.createRequirement(context('http')));
        return [await by.createRequirement(context('mcp')), payload];
      },
    ],
    [
      'a proof for a challenge issued before the switch',
      async (offers) => {
        const payload = await sdkProof(await provider(offers).createRequirement(context('http')));
        return [await provider(offers, URLS).createRequirement(context('http')), payload];
      },
    ],
  ];

  it.each(
    REFUSED.flatMap(([label, build]) => [1, 2].map((offers) => [label, offers, build] as const)),
  )('refuses %s, with %i offer(s), before the facilitator', async (_label, offers, build) => {
    const [requirement, payload] = await build(offers as 1 | 2);
    const { result } = await verify(provider(offers as 1 | 2, URLS), requirement, payload);
    expect(result).toMatchObject({
      status: 'rejected',
      rejectionReason: 'invalid_payment_requirements',
    });
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('derives one replay key from one authorization under either URL form', async () => {
    const before = await provider(1).createRequirement(context('http'));
    const after = await provider(1, URLS).createRequirement(context('http'));
    const signed = await sdkProof(before);
    // The same signed authorization, echoing the public URL instead
    const echoed = {
      ...signed,
      resource: (after.challenge.envelope as unknown as PaymentRequired).resource,
    };

    const old = await verify(provider(1), before, signed);
    const opted = await verify(provider(1, URLS), after, echoed);
    expect(old.result.status).toBe('verified');
    expect(opted.result.status).toBe('verified');
    expect(opted.result.replayKey).toBeDefined();
    expect(opted.result.replayKey).toBe(old.result.replayKey);
  });
});
