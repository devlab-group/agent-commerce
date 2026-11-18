// Bazaar challenge metadata, HTTP header limits and facilitator payloads
import { x402Client } from '@x402/core/client';
import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CommerceResource,
  NOOP_LOGGER,
  type PaymentContext,
  type PaymentRequirement,
  type ProtocolName,
} from '../../../src/core';
import {
  createX402PaymentProvider,
  type X402ProviderOptions,
} from '../../../src/payments/x402/provider';
import { createBazaarForwarding } from '../../../src/payments/x402/provider/bazaar-forwarding';
import type { ProviderContext } from '../../../src/payments/x402/provider/types';

const facilitator = vi.hoisted(() => ({ verify: vi.fn(), settle: vi.fn(), supported: vi.fn() }));

// Mock the facilitator HTTP client to inspect the payment payloads passed to it
vi.mock('@x402/core/http', () => ({
  FacilitatorResponseError: class extends Error {},
  HTTPFacilitatorClient: class {
    verify(...args: unknown[]) {
      return facilitator.verify(...args);
    }
    settle(...args: unknown[]) {
      return facilitator.settle(...args);
    }
    getSupported() {
      return facilitator.supported();
    }
  },
}));

const PAY_TO = '0x1111111111111111111111111111111111111111';
const BUYER = privateKeyToAccount(
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
);
const BASE = 'https://shop.example';
const URLS = {
  report: { http: `${BASE}/api/resources/report/invoke`, mcp: `${BASE}/mcp`, a2a: `${BASE}/a2a` },
};
const bazaarFor = (surface: string, pad = '') => ({
  info: { input: { type: surface, pad } },
  schema: { type: 'object' },
});
const BAZAAR = { report: { http: bazaarFor('http'), mcp: bazaarFor('mcp') } };

const RESOURCE: CommerceResource = {
  id: 'report',
  name: 'Report',
  handler: { type: 'http', method: 'GET', url: 'http://merchant.invalid/report' },
  pricing: { type: 'fixed', amount: '0.01', currency: 'USD' },
  exposedVia: ['http', 'mcp', 'a2a'],
  paymentMethods: ['x402'],
};

function provider(overrides: Partial<X402ProviderOptions> = {}) {
  return createX402PaymentProvider({
    network: 'eip155:31337',
    rpcUrl: 'http://127.0.0.1:19321', // never contacted
    asset: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    assetName: 'MockUSDC',
    assetVersion: '2',
    assetDecimals: 6,
    payTo: PAY_TO,
    facilitator: { mode: 'remote', url: 'https://facilitator.example', auth: { type: 'none' } },
    resourceUrls: URLS,
    ...overrides,
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

const envelopeOf = (requirement: PaymentRequirement) =>
  requirement.challenge.envelope as unknown as PaymentRequired;

async function sdkProof(requirement: PaymentRequirement): Promise<PaymentPayload> {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: BUYER, networks: ['eip155:31337'] });
  client.setSpendControls(false); // the test token is not in the SDK's list
  return client.createPaymentPayload(envelopeOf(requirement));
}

// Verify and settle a proof, returning the payloads passed to the facilitator client
async function pay(
  by: ReturnType<typeof provider>,
  requirement: PaymentRequirement,
  proof: PaymentPayload,
) {
  const ctx = {
    requestId: 'req-1',
    resource: RESOURCE,
    requirement,
    submission: {
      method: 'x402' as const,
      payload: Buffer.from(JSON.stringify(proof)).toString('base64'),
    },
  };
  const verification = await by.verify(ctx);
  expect(verification.status).toBe('verified');
  const settlement = await by.settle({ ...ctx, verification });
  expect(settlement.status).toBe('settled');
  return {
    verified: facilitator.verify.mock.calls[0]?.[0] as Record<string, unknown>,
    settled: facilitator.settle.mock.calls[0]?.[0] as Record<string, unknown>,
  };
}

const supported = (extensions: string[]) => ({
  kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:31337' }],
  extensions,
  signers: {},
});

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  facilitator.supported.mockReset().mockResolvedValue(supported(['bazaar']));
  facilitator.verify.mockReset().mockResolvedValue({ isValid: true, payer: BUYER.address });
  facilitator.settle.mockReset().mockResolvedValue({
    success: true,
    transaction: `0x${'ab'.repeat(32)}`,
    network: 'eip155:31337',
    payer: BUYER.address,
  });
});

describe('Bazaar metadata in the challenge', () => {
  it.each(['http', 'mcp'] as const)('carries the %s extension on that surface', async (surface) => {
    const envelope = envelopeOf(
      await provider({ resourceBazaar: BAZAAR }).createRequirement(context(surface)),
    );
    expect(envelope.extensions).toEqual({ bazaar: BAZAAR.report[surface] });
  });

  it.each([
    ['A2A', 'a2a'],
    ['ACP', 'acp'],
    ['no surface', undefined],
  ] as const)('carries none on %s', async (_label, surface) => {
    const envelope = envelopeOf(
      await provider({ resourceBazaar: BAZAAR }).createRequirement(context(surface)),
    );
    expect(envelope).not.toHaveProperty('extensions');
  });

  // Measure the HTTP envelope overhead before padding it to the target size
  async function sizedHttpChallenge(encodedBytes: number) {
    const base = envelopeOf(
      await provider({ resourceBazaar: { report: { http: bazaarFor('http') } } }).createRequirement(
        context('http'),
      ),
    );
    const jsonBytes = Buffer.byteLength(JSON.stringify(base));
    const pad = 'p'.repeat((encodedBytes / 4) * 3 - jsonBytes);
    return { pad, extension: bazaarFor('http', pad) };
  }

  // 8192 less the 1024 bytes kept for an EVM proof
  const EVM_LIMIT = 7168;
  const encodedLength = (document: unknown) =>
    Buffer.from(JSON.stringify(document)).toString('base64').length;

  it('keeps it when the encoded HTTP challenge leaves exactly 1024 bytes of an 8192-byte header', async () => {
    const { pad, extension } = await sizedHttpChallenge(EVM_LIMIT);
    const envelope = envelopeOf(
      await provider({ resourceBazaar: { report: { http: extension } } }).createRequirement(
        context('http'),
      ),
    );
    expect(encodedLength(envelope)).toBe(EVM_LIMIT);
    expect(envelope.extensions).toEqual({ bazaar: bazaarFor('http', pad) });
  });

  it('fits the SDK client echo of the largest kept challenge in an 8192-byte header', async () => {
    const { extension } = await sizedHttpChallenge(EVM_LIMIT);
    const requirement = await provider({
      resourceBazaar: { report: { http: extension } },
    }).createRequirement(context('http'));

    const proof = await sdkProof(requirement);

    // The echo repeats the metadata and adds the signed payload
    expect(proof.extensions).toEqual({ bazaar: extension });
    expect(encodedLength(proof)).toBeGreaterThan(EVM_LIMIT);
    expect(encodedLength(proof)).toBeLessThanOrEqual(8192);
  });

  it("fits a refused proof's challenge with the longest error code in an 8192-byte header", async () => {
    const { extension } = await sizedHttpChallenge(EVM_LIMIT);
    const envelope = envelopeOf(
      await provider({ resourceBazaar: { report: { http: extension } } }).createRequirement(
        context('http'),
      ),
    );
    // A provider reason is at most 128 characters
    expect(encodedLength({ ...envelope, error: 'r'.repeat(128) })).toBeLessThanOrEqual(8192);
  });

  it('leaves it out of an HTTP challenge one byte over, and logs that once per resource', async () => {
    const { extension } = await sizedHttpChallenge(EVM_LIMIT);
    const big = {
      ...extension,
      info: { input: { ...extension.info.input, pad: `${extension.info.input.pad}p` } },
    };
    // Exceed the HTTP budget even with MCP's shorter URL
    const bigger = bazaarFor('mcp', 'p'.repeat(extension.info.input.pad.length + 1024));
    const warn = vi.fn();
    const by = provider({
      resourceBazaar: { report: { http: big, mcp: bigger } },
      logger: { ...NOOP_LOGGER, warn },
    });

    const first = envelopeOf(await by.createRequirement(context('http')));
    const second = envelopeOf(await by.createRequirement(context('http')));
    // MCP carries the challenge in the result body, not a header
    const mcp = envelopeOf(await by.createRequirement(context('mcp')));

    expect(first).not.toHaveProperty('extensions');
    expect(second).not.toHaveProperty('extensions');
    expect(mcp.extensions).toEqual({ bazaar: bigger });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { resourceId: 'report', bytes: EVM_LIMIT + 4, reservedBytes: 1024 },
      'x402: Bazaar metadata left out of an HTTP challenge too large to leave room for the signed proof in an 8 KiB header',
    );
  });
});

describe('Bazaar metadata and AP2', () => {
  // The requirement fields an AP2 mandate binds (src/authorization/ap2/profile.ts)
  const bound = ({
    resourceId,
    provider,
    amount,
    currency,
    destination,
    network,
    asset,
  }: PaymentRequirement) => ({
    resourceId,
    provider,
    amount,
    currency,
    destination,
    network,
    asset,
  });

  it('leaves every field a mandate binds unchanged', async () => {
    const on = await provider({ resourceBazaar: BAZAAR }).createRequirement(context('http'));
    const off = await provider({ resourceUrls: {} }).createRequirement(context('http'));
    expect(envelopeOf(on).extensions).toEqual({ bazaar: BAZAAR.report.http });
    expect(bound(on)).toEqual({
      resourceId: 'report',
      provider: 'x402',
      amount: '0.01',
      currency: 'USD',
      destination: PAY_TO,
      network: 'eip155:31337',
      asset: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    });
    expect(bound(on)).toEqual(bound(off));
  });
});

describe('Bazaar metadata and offer selection', () => {
  it('selects the offer the proof pays, whatever metadata it echoes, and still forwards the issued metadata', async () => {
    const OTHER_ASSET = '0x2222222222222222222222222222222222222222';
    const OTHER_PAY_TO = '0x3333333333333333333333333333333333333333';
    const offer = (asset: string, payTo: string) => ({
      network: 'eip155:31337',
      rpcUrl: 'http://127.0.0.1:19321', // never contacted
      asset,
      assetName: 'MockUSDC',
      assetVersion: '2',
      assetDecimals: 6,
      payTo,
    });
    const by = createX402PaymentProvider({
      offers: [
        offer('0x5FbDB2315678afecb367f032d93F642f64180aa3', PAY_TO),
        offer(OTHER_ASSET, OTHER_PAY_TO),
      ],
      facilitator: { mode: 'remote', url: 'https://facilitator.example', auth: { type: 'none' } },
      resourceUrls: URLS,
      resourceBazaar: BAZAAR,
    });
    const requirement = await by.createRequirement(context('http'));
    const client = new x402Client((_version, accepts) => accepts[1] as never);
    registerExactEvmScheme(client, { signer: BUYER, networks: ['eip155:31337'] });
    client.setSpendControls(false); // the test token is not in the SDK's list
    const proof = await client.createPaymentPayload(envelopeOf(requirement));
    // The other surface's metadata, echoed as if it were this challenge's
    const echoed = { ...proof, extensions: { bazaar: BAZAAR.report.mcp } };

    const selected = await by.selectRequirement?.({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: {
        method: 'x402',
        payload: Buffer.from(JSON.stringify(echoed)).toString('base64'),
      },
    });
    if (selected === undefined) return expect.unreachable('no selectRequirement');
    const { verified } = await pay(by, selected, echoed);

    expect({ destination: selected.destination, asset: selected.asset }).toEqual({
      destination: OTHER_PAY_TO,
      asset: OTHER_ASSET,
    });
    expect(verified['accepted']).toEqual(proof.accepted);
    expect(verified['extensions']).toEqual({ bazaar: BAZAAR.report.http });
  });
});

describe('Bazaar metadata on the way to the facilitator', () => {
  it('sends only x402Version, accepted and payload when the challenge has none', async () => {
    const by = provider();
    const requirement = await by.createRequirement(context('http'));
    const { verified, settled } = await pay(by, requirement, await sdkProof(requirement));
    expect(Object.keys(verified)).toEqual(['x402Version', 'accepted', 'payload']);
    expect(Object.keys(settled)).toEqual(['x402Version', 'accepted', 'payload']);
  });

  it('forwards Bazaar alone from a challenge that also declares payment-identifier', async () => {
    const by = provider({ resourceBazaar: BAZAAR });
    const resource: CommerceResource = {
      ...RESOURCE,
      idempotency: { redelivery: { retentionHours: 24, required: false } },
    };
    const requirement = await by.createRequirement({ ...context('http'), resource });
    expect(Object.keys(envelopeOf(requirement).extensions ?? {})).toEqual([
      'payment-identifier',
      'bazaar',
    ]);

    const { verified, settled } = await pay(by, requirement, await sdkProof(requirement));

    expect(verified['extensions']).toEqual({ bazaar: BAZAAR.report.http });
    expect(settled['extensions']).toEqual({ bazaar: BAZAAR.report.http });
  });

  // Each echo is the SDK client's proof after the buyer changes its extensions
  const ECHOES: readonly [string, (proof: PaymentPayload) => PaymentPayload][] = [
    ['the echo unchanged', (proof) => proof],
    [
      'altered Bazaar metadata',
      (proof) => ({
        ...proof,
        extensions: { bazaar: { info: { input: { type: 'http', body: { poisoned: true } } } } },
      }),
    ],
    [
      'an altered description and added service metadata',
      (proof) => ({
        ...proof,
        resource: {
          ...(proof.resource as PaymentRequired['resource']),
          description: 'Free money',
          serviceName: 'Hostile',
          tags: ['spam'],
        } as PaymentRequired['resource'],
      }),
    ],
    [
      'a payment-identifier extension',
      (proof) => ({
        ...proof,
        extensions: {
          ...proof.extensions,
          'payment-identifier': { info: { id: 'pay_1234567890abcdef' } },
        },
      }),
    ],
    [
      'an ERC-8409 quote extension',
      (proof) => ({
        ...proof,
        extensions: { ...proof.extensions, 'erc-8409': { quotes: [{ signature: '0x00' }] } },
      }),
    ],
    [
      'a gas-sponsoring extension',
      (proof) => ({
        ...proof,
        extensions: { ...proof.extensions, eip2612GasSponsoring: { info: { signature: '0x00' } } },
      }),
    ],
  ];

  it.each(ECHOES)(
    'forwards the issued resource and Bazaar metadata, given %s',
    async (_label, edit) => {
      const by = provider({ resourceBazaar: BAZAAR });
      const requirement = await by.createRequirement(context('http'));
      const issued = envelopeOf(requirement);
      const proof = await sdkProof(requirement);

      const { verified, settled } = await pay(by, requirement, edit(proof));

      const expected = {
        x402Version: 2,
        accepted: proof.accepted,
        payload: proof.payload,
        resource: issued.resource,
        extensions: { bazaar: BAZAAR.report.http },
      };
      expect(verified).toEqual(expected);
      expect(settled).toEqual(expected);
    },
  );
});

describe('Bazaar metadata and the facilitator /supported list', () => {
  const THREE_KEYS = ['x402Version', 'accepted', 'payload'];

  it('sends none to a facilitator that does not list the extension, and warns once', async () => {
    facilitator.supported.mockResolvedValue(supported(['eip2612GasSponsoring']));
    const warn = vi.fn();
    const by = provider({ resourceBazaar: BAZAAR, logger: { ...NOOP_LOGGER, warn } });
    const requirement = await by.createRequirement(context('http'));
    expect(envelopeOf(requirement).extensions).toEqual({ bazaar: BAZAAR.report.http });

    const { verified, settled } = await pay(by, requirement, await sdkProof(requirement));
    await pay(by, requirement, await sdkProof(requirement));

    expect(Object.keys(verified)).toEqual(THREE_KEYS);
    expect(Object.keys(settled)).toEqual(THREE_KEYS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { facilitator: 'remote https://facilitator.example (auth=none)' },
      'x402: the facilitator does not list the bazaar extension in /supported; Bazaar metadata stays in challenges but is not sent to it',
    );
  });

  it('sends none, and still verifies and settles, when /supported fails', async () => {
    facilitator.supported.mockRejectedValue(new Error('facilitator down'));
    const by = provider({ resourceBazaar: BAZAAR });
    const requirement = await by.createRequirement(context('http'));

    const { verified, settled } = await pay(by, requirement, await sdkProof(requirement));

    expect(Object.keys(verified)).toEqual(THREE_KEYS);
    expect(Object.keys(settled)).toEqual(THREE_KEYS);
  });

  it('sends none, and waits one second per call, when /supported does not answer', async () => {
    const by = provider({ resourceBazaar: BAZAAR });
    const requirement = await by.createRequirement(context('http'));
    const proof = await sdkProof(requirement);
    facilitator.supported.mockReturnValue(new Promise(() => {}));
    vi.useFakeTimers();

    const paying = pay(by, requirement, proof);
    await vi.advanceTimersByTimeAsync(999);
    expect(facilitator.verify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    const { verified, settled } = await paying;

    expect(Object.keys(verified)).toEqual(THREE_KEYS);
    expect(Object.keys(settled)).toEqual(THREE_KEYS);
  });

  it('does not read /supported for a challenge without the metadata', async () => {
    const by = provider();
    const requirement = await by.createRequirement(context('http'));

    await pay(by, requirement, await sdkProof(requirement));

    expect(facilitator.supported).not.toHaveBeenCalled();
  });
});

describe('Bazaar metadata and the in-process facilitator', () => {
  it('gets none, and /supported is not read, since it keeps no catalog', async () => {
    const currentSupported = vi.fn();
    const forwarding = createBazaarForwarding(
      { remoteBinding: undefined, logger: NOOP_LOGGER } as unknown as ProviderContext,
      currentSupported,
    );
    const issued = envelopeOf(
      await provider({ resourceBazaar: BAZAAR }).createRequirement(context('http')),
    );
    expect(issued.extensions).toEqual({ bazaar: BAZAAR.report.http });

    expect(await forwarding.issuedFor(issued)).toBeUndefined();
    expect(currentSupported).not.toHaveBeenCalled();
  });
});

describe('Bazaar outcome from the facilitator', () => {
  const REJECTED = {
    bazaar: {
      status: 'rejected',
      rejectedReason: `info failed schema validation at https://user:secret@catalog.example/v1?key=abc ${'x'.repeat(400)}`,
    },
  };
  const REJECTION_MESSAGE =
    'x402: the facilitator rejected the Bazaar metadata of a resource and will not catalog it. Payment is unaffected';

  async function payWith(by: ReturnType<typeof provider>) {
    const requirement = await by.createRequirement(context('http'));
    return pay(by, requirement, await sdkProof(requirement));
  }

  it('logs a rejection on verify once per resource, with the reason redacted and cut to 200 characters', async () => {
    facilitator.verify.mockResolvedValue({
      isValid: true,
      payer: BUYER.address,
      extensionResponses: REJECTED,
    });
    const warn = vi.fn();
    const by = provider({ resourceBazaar: BAZAAR, logger: { ...NOOP_LOGGER, warn } });

    await payWith(by);
    await payWith(by);

    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0] as [Record<string, string>, string];
    expect(message).toBe(REJECTION_MESSAGE);
    expect(fields).toEqual({
      resourceId: 'report',
      reportedReason:
        `info failed schema validation at https://catalog.example ${'x'.repeat(400)}`.slice(0, 200),
    });
  });

  it('logs a rejection that arrives on settle', async () => {
    facilitator.settle.mockResolvedValue({
      success: true,
      transaction: `0x${'ab'.repeat(32)}`,
      network: 'eip155:31337',
      payer: BUYER.address,
      extensionResponses: { bazaar: { status: 'rejected' } },
    });
    const warn = vi.fn();
    const by = provider({ resourceBazaar: BAZAAR, logger: { ...NOOP_LOGGER, warn } });

    await payWith(by);

    expect(warn.mock.calls).toEqual([[{ resourceId: 'report' }, REJECTION_MESSAGE]]);
  });

  it.each(['success', 'processing'])('logs nothing for a %s outcome', async (status) => {
    facilitator.verify.mockResolvedValue({
      isValid: true,
      payer: BUYER.address,
      extensionResponses: { bazaar: { status } },
    });
    const warn = vi.fn();
    const by = provider({ resourceBazaar: BAZAAR, logger: { ...NOOP_LOGGER, warn } });

    await payWith(by);

    expect(warn).not.toHaveBeenCalled();
  });
});
