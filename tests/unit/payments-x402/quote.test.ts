// Checks the ERC-8409 test vector, the request hash, challenge quotes, cache
// reuse and issuer key validation
import Ajv2020 from 'ajv/dist/2020.js';
import { type Hex, hashTypedData, keccak256, recoverTypedDataAddress, stringToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Clock, CommerceResource, PaymentContext } from '../../../src/core';
import { ANVIL_WELL_KNOWN_ACCOUNTS } from '../../../src/payments/x402/local-chain/accounts';
import {
  createX402PaymentProvider,
  type X402MultiOfferProviderOptions,
  type X402OfferOptions,
} from '../../../src/payments/x402/provider';
import {
  QUOTE_DOMAIN,
  QUOTE_TYPES,
  quoteRequestHash,
} from '../../../src/payments/x402/provider/quote';

// Test-only key, never funded
const QUOTE_KEY = `0x${'33'.repeat(32)}` as const;
const ISSUER = privateKeyToAccount(QUOTE_KEY).address;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const PAY_TO = `0x${'ab'.repeat(20)}`;
const BASE_SEPOLIA: X402OfferOptions = {
  network: 'eip155:84532',
  rpcUrl: 'https://base-sepolia.example',
  asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  assetName: 'USDC',
  assetVersion: '2',
  assetDecimals: 6,
  payTo: PAY_TO,
};
const ARBITRUM_SEPOLIA: X402OfferOptions = {
  ...BASE_SEPOLIA,
  network: 'eip155:421614',
  rpcUrl: 'https://arbitrum-sepolia.example',
  asset: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d',
  assetName: 'USD Coin',
};
const NEAR_TESTNET: X402OfferOptions = {
  network: 'near:testnet',
  rpcUrl: 'https://near-testnet.example',
  asset: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
  assetDecimals: 6,
  payTo: 'merchant.testnet',
};

const T0 = Date.parse('2026-10-18T12:00:00.000Z') / 1000;
let nowSeconds = T0;
const clock: Clock = {
  now: () => new Date(nowSeconds * 1000),
  nowIso: () => new Date(nowSeconds * 1000).toISOString() as ReturnType<Clock['nowIso']>,
  monotonicMs: () => nowSeconds * 1000,
};
beforeEach(() => {
  nowSeconds = T0;
});

function makeProvider(overrides: Partial<X402MultiOfferProviderOptions> = {}) {
  return createX402PaymentProvider({
    offers: [BASE_SEPOLIA, ARBITRUM_SEPOLIA, NEAR_TESTNET],
    facilitator: { mode: 'remote', url: 'https://facilitator.example', auth: { type: 'none' } },
    quote: { signerPrivateKey: QUOTE_KEY },
    clock,
    ...overrides,
  });
}

const RESOURCE: CommerceResource = {
  id: 'demo.report',
  name: 'Demo report',
  handler: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
  pricing: { type: 'fixed', amount: '0.01', currency: 'USD' },
  exposedVia: ['http'],
  paymentMethods: ['x402'],
};

function paymentContext(overrides: Partial<PaymentContext> = {}): PaymentContext {
  return {
    requestId: 'req-1',
    resource: RESOURCE,
    amount: '0.01',
    currency: 'USD',
    requestedAt: new Date(nowSeconds * 1000).toISOString(),
    input: { city: 'Paris' },
    ...overrides,
  };
}

interface WireQuote {
  readonly chainId: string;
  readonly quote: Record<string, string>;
  readonly signature: Hex;
}

async function challengeOf(provider: ReturnType<typeof makeProvider>, context = paymentContext()) {
  const requirement = await provider.createRequirement(context);
  return requirement.challenge.envelope as Record<string, unknown> & {
    readonly accepts: readonly unknown[];
    readonly extensions?: { readonly 'erc-8409': { readonly info: { quotes: WireQuote[] } } };
  };
}

async function quotesOf(provider: ReturnType<typeof makeProvider>, context = paymentContext()) {
  const quotes = (await challengeOf(provider, context)).extensions?.['erc-8409'].info.quotes;
  if (quotes === undefined) throw new Error('the challenge lists no quotes');
  return quotes;
}

function recoverIssuer({ chainId, quote, signature }: WireQuote) {
  return recoverTypedDataAddress({
    domain: { ...QUOTE_DOMAIN, chainId: Number(chainId) },
    types: QUOTE_TYPES,
    primaryType: 'ServicePaymentQuote',
    message: {
      ...quote,
      amount: BigInt(quote['amount'] as string),
      validAfter: BigInt(quote['validAfter'] as string),
      validUntil: BigInt(quote['validUntil'] as string),
    } as never,
    signature,
  });
}

describe('ERC-8409 typed data', () => {
  // The canonical vector of ERCS/erc-8409.md at the pinned commit
  const VECTOR = {
    domain: { ...QUOTE_DOMAIN, chainId: 8453 },
    types: QUOTE_TYPES,
    primaryType: 'ServicePaymentQuote',
    message: {
      issuer: '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
      payer: '0x2222222222222222222222222222222222222222',
      recipient: '0x3333333333333333333333333333333333333333',
      asset: '0x4444444444444444444444444444444444444444',
      amount: 1000000n,
      requestScheme: 'com.example.service/1',
      requestHash: `0x${'a'.repeat(64)}`,
      quoteId: `0x${'b'.repeat(64)}`,
      validAfter: 1788372000n,
      validUntil: 1788372300n,
    },
  } as const;

  it('reproduces the vector digest', () => {
    expect(hashTypedData(VECTOR)).toBe(
      '0xc80f6a3da4ad8d3636a7e4de909f46180ef8c3af67cf46f55736632c4a93fc65',
    );
  });

  it('reproduces the vector signature with its public test key', async () => {
    const account = privateKeyToAccount(`0x${'0'.repeat(63)}1`);
    expect(await account.signTypedData(VECTOR)).toBe(
      '0x2051fd043967b356866060fb9bf95e11b735f03cab03d0f7f6c736abbdf55a42311f85b1f7f34e4f1008a494fb10aed2965589f96fca3f99c2bb72994ab345e41c',
    );
  });
});

describe('quoteRequestHash', () => {
  it('hashes the canonical {input, resource} object with Keccak-256', () => {
    expect(quoteRequestHash('demo.report', { city: 'Paris', days: [1, 2] })).toBe(
      keccak256(stringToBytes('{"input":{"city":"Paris","days":[1,2]},"resource":"demo.report"}')),
    );
  });
});

describe('challenge quotes', () => {
  const PARIS_HASH = keccak256(
    stringToBytes('{"input":{"city":"Paris"},"resource":"demo.report"}'),
  );

  it("lists one quote per EVM offer, carrying that offer's terms", async () => {
    const quotes = await quotesOf(makeProvider());

    const terms = (chainId: string, asset: string) => ({
      chainId,
      quote: {
        issuer: ISSUER,
        payer: ZERO_ADDRESS,
        recipient: PAY_TO,
        asset,
        amount: '10000',
        requestScheme: 'agent-commerce/request/v1',
        requestHash: PARIS_HASH,
        quoteId: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        validAfter: String(T0),
        validUntil: String(T0 + 120),
      },
      signature: expect.any(String),
    });
    // NEAR offers get no quotes because the ERC covers EVM chains only
    expect(quotes).toEqual([
      terms('84532', BASE_SEPOLIA.asset),
      terms('421614', ARBITRUM_SEPOLIA.asset),
    ]);
  });

  it("signs each quote with the issuer key over the ERC's typed data", async () => {
    for (const quote of await quotesOf(makeProvider())) {
      expect(await recoverIssuer(quote)).toBe(ISSUER);
    }
  });

  it('encodes signatures as the ERC requires: 65 bytes, low s, v of 27 or 28', async () => {
    for (const { signature } of await quotesOf(makeProvider())) {
      expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
      const s = BigInt(`0x${signature.slice(66, 130)}`);
      expect(s <= SECP256K1_N / 2n).toBe(true);
      expect(['1b', '1c']).toContain(signature.slice(130));
    }
  });

  it('binds quotes to the input, with a distinct quote id per offer and input', async () => {
    const provider = makeProvider();
    const paris = await quotesOf(provider);
    const rome = await quotesOf(provider, paymentContext({ input: { city: 'Rome' } }));

    expect(rome[0]?.quote['requestHash']).toBe(
      keccak256(stringToBytes('{"input":{"city":"Rome"},"resource":"demo.report"}')),
    );
    const ids = [...paris, ...rome].map(({ quote }) => quote['quoteId']);
    expect(new Set(ids).size).toBe(4);
  });

  it('declares a JSON Schema beside the info, as x402 v2 requires, and the info satisfies it', async () => {
    const extension = (
      (await challengeOf(makeProvider())).extensions as unknown as Record<
        string,
        Record<string, unknown>
      >
    )['erc-8409'];
    expect(Object.keys(extension ?? {}).sort()).toEqual(['info', 'schema']);
    const validate = new Ajv2020({ strict: true }).compile(extension?.['schema'] as object);
    expect(validate(extension?.['info'])).toBe(true);
    expect(validate({ quotes: [{ chainId: '84532', quote: {}, signature: '0x' }] })).toBe(false);
  });

  it('names the capability in the descriptor', () => {
    expect(makeProvider().descriptor.capabilities).toContain('erc-8409-quotes');
  });

  it('leaves the challenge without extensions when quote is not configured', async () => {
    const provider = createX402PaymentProvider({
      offers: [BASE_SEPOLIA],
      facilitator: { mode: 'remote', url: 'https://facilitator.example', auth: { type: 'none' } },
      clock,
    });

    const envelope = (await provider.createRequirement(paymentContext())).challenge.envelope;
    expect(Object.keys(envelope ?? {})).toEqual(['x402Version', 'resource', 'accepts']);
    expect(provider.descriptor.capabilities).not.toContain('erc-8409-quotes');
  });

  it('lists no quotes for a context without input', async () => {
    const { input: _input, ...withoutInput } = paymentContext();
    const envelope = await challengeOf(makeProvider(), withoutInput);
    expect(envelope).not.toHaveProperty('extensions');
    expect(envelope.accepts).toHaveLength(3);
  });

  it('still offers payment, without quotes, for input RFC 8785 cannot represent', async () => {
    const envelope = await challengeOf(
      makeProvider(),
      paymentContext({ input: { city: 'a\ud800b' } }),
    );
    expect(envelope).not.toHaveProperty('extensions');
    expect(envelope.accepts).toHaveLength(3);
  });

  it('lists no quotes for a resource whose offers are all NEAR', async () => {
    const provider = makeProvider({ resourceOffers: { 'near.only': [NEAR_TESTNET] } });
    const envelope = await challengeOf(
      provider,
      paymentContext({ resource: { ...RESOURCE, id: 'near.only' } }),
    );
    expect(envelope).not.toHaveProperty('extensions');
    expect(envelope.accepts).toHaveLength(1);
  });
});

describe('quote reuse', () => {
  // A 30-second payment window: quotes are valid for 60 seconds
  const provider = () => makeProvider({ maxTimeoutSeconds: 30 });

  it('serves the same quote while a full payment window remains', async () => {
    const issuing = provider();
    const first = await quotesOf(issuing);
    nowSeconds = T0 + 30;
    expect(await quotesOf(issuing)).toEqual(first);
    expect(first[0]?.quote['validUntil']).toBe(String(T0 + 60));
  });

  it('signs a new quote once less than a payment window remains', async () => {
    const issuing = provider();
    const first = await quotesOf(issuing);
    nowSeconds = T0 + 31;
    const second = await quotesOf(issuing);

    expect(second[0]?.quote['quoteId']).not.toBe(first[0]?.quote['quoteId']);
    expect(second[0]?.quote['validAfter']).toBe(String(T0 + 31));
    expect(second[0]?.quote['validUntil']).toBe(String(T0 + 91));
  });

  it('stops reusing the oldest quote after 1024 newer inputs', async () => {
    const issuing = makeProvider({ offers: [BASE_SEPOLIA] });
    const forInput = (n: number) => quotesOf(issuing, paymentContext({ input: { n } }));
    const oldest = await forInput(0);
    for (let n = 1; n <= 1024; n += 1) await forInput(n);
    const newest = await forInput(1024);

    expect((await forInput(0))[0]?.quote['quoteId']).not.toBe(oldest[0]?.quote['quoteId']);
    expect(await forInput(1024)).toEqual(newest);
  });
});

describe('quote key checks at construction', () => {
  it.each([
    ['too short', '0x1234'],
    ['not hex', `0x${'zz'.repeat(32)}`],
    ['missing its 0x prefix', '33'.repeat(32)],
    ['zero', `0x${'00'.repeat(32)}`],
  ])('refuses a key that is %s, without echoing it', (_name, key) => {
    let thrown: unknown;
    try {
      makeProvider({ quote: { signerPrivateKey: key } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'CONFIG_INVALID' });
    expect((thrown as Error).message).not.toContain(key);
  });

  it('refuses a well-known Anvil key on a testnet', () => {
    const anvil = ANVIL_WELL_KNOWN_ACCOUNTS[0];
    expect(() => makeProvider({ quote: { signerPrivateKey: anvil.privateKey } })).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });

  it('accepts a well-known Anvil key on the local chain', async () => {
    const anvil = ANVIL_WELL_KNOWN_ACCOUNTS[0];
    const provider = makeProvider({
      offers: [{ ...BASE_SEPOLIA, network: 'eip155:31337', rpcUrl: 'http://127.0.0.1:8545' }],
      facilitator: { mode: 'local', signerPrivateKey: ANVIL_WELL_KNOWN_ACCOUNTS[1].privateKey },
      quote: { signerPrivateKey: anvil.privateKey },
    });
    const [quote] = await quotesOf(provider);
    expect(quote?.chainId).toBe('31337');
    expect(quote?.quote['issuer']).toBe(anvil.address);
  });

  it("refuses a key that controls a resource offer's payTo, whatever the case", () => {
    const merchant = { ...ARBITRUM_SEPOLIA, payTo: ISSUER.toLowerCase() };
    expect(() => makeProvider({ resourceOffers: { 'demo.other': [merchant] } })).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });

  it('refuses quotes for a provider without an EVM offer', () => {
    expect(() => makeProvider({ offers: [NEAR_TESTNET] })).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });
});
