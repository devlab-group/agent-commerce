/**
 * Exercise the real provider's payment-identifier challenge, retry-key
 * extraction, echo validation and facilitator payloads. A stub HTTP facilitator
 * on 127.0.0.1 lets verify() and settle() use the remote binding without a chain.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { x402Client } from '@x402/core/client';
import type { PaymentRequired } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Clock, CommerceResource, PaymentRequirement } from '../../../src/core';
import { createPaymentProof } from '../../../src/payments/x402/client';
import { decodePaymentSubmission } from '../../../src/payments/x402/payload';
import {
  createX402PaymentProvider,
  type X402ProviderOptions,
} from '../../../src/payments/x402/provider';
import { x402ErrorCode } from '../../../src/payments/x402/transport';

const ASSET = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;
const PAY_TO = '0x1111111111111111111111111111111111111111' as const;
// LOCAL DEVELOPMENT ONLY - DO NOT FUND (Anvil account 1)
const BUYER_PRIVATE_KEY =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;
const BUYER = privateKeyToAccount(BUYER_PRIVATE_KEY).address;
const QUOTE_KEY = `0x${'33'.repeat(32)}` as const;
const NONCE = `0x${'01'.repeat(32)}` as const;
const PINNED_ID = 'pay_0123456789abcdef';
const KEY = 'payment-identifier';

// declarePaymentIdentifierExtension(required) from @x402/extensions 2.25.0
function declared(required: boolean): Record<string, unknown> {
  return {
    info: { required },
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        required: { type: 'boolean' },
        id: { type: 'string', minLength: 16, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' },
      },
      required: ['required'],
    },
  };
}

const PLAIN: CommerceResource = {
  id: 'demo.report',
  name: 'Demo report',
  handler: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
  pricing: { type: 'fixed', amount: '0.01', currency: 'USD' },
  exposedVia: ['http'],
  paymentMethods: ['x402'],
};
const OPTIONAL: CommerceResource = {
  ...PLAIN,
  idempotency: { redelivery: { retentionHours: 24, required: false } },
};
const REQUIRED: CommerceResource = {
  ...PLAIN,
  idempotency: { redelivery: { retentionHours: 24, required: true } },
};

const clock: Clock = {
  now: () => new Date('2026-11-07T12:00:00.000Z'),
  nowIso: () => '2026-11-07T12:00:00.000Z',
  monotonicMs: () => 0,
};

interface Facilitator {
  url: string;
  requests: string[];
  bodies: string[];
}

const facilitator: Facilitator = { url: '', requests: [], bodies: [] };
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  facilitator.requests.push(`${req.method} ${req.url}`);
  facilitator.bodies.push(Buffer.concat(chunks).toString('utf8'));
  const answer = req.url?.endsWith('/verify')
    ? { isValid: true, payer: BUYER }
    : { success: true, transaction: `0x${'ab'.repeat(32)}`, network: 'eip155:31337', payer: BUYER };
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  facilitator.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  facilitator.requests = [];
  facilitator.bodies = [];
});

function makeProvider(overrides: Partial<X402ProviderOptions> = {}) {
  return createX402PaymentProvider({
    network: 'eip155:31337',
    // Never contacted: the facilitator answers for the chain
    rpcUrl: 'http://127.0.0.1:9',
    asset: ASSET,
    assetName: 'MockUSDC',
    assetVersion: '2',
    assetDecimals: 6,
    payTo: PAY_TO,
    facilitator: { mode: 'remote', url: facilitator.url, auth: { type: 'none' } },
    clock,
    ...overrides,
  });
}

function challengeFor(provider: ReturnType<typeof makeProvider>, resource: CommerceResource) {
  return provider.createRequirement({
    requestId: 'req-1',
    resource,
    amount: '0.01',
    currency: 'USD',
    requestedAt: clock.nowIso(),
    input: {},
  });
}

const envelopeOf = (requirement: PaymentRequirement) =>
  requirement.challenge.envelope as unknown as PaymentRequired;

// The challenge's declaration with `info` changed as a buyer would echo it
function echo(requirement: PaymentRequirement, info: Record<string, unknown>) {
  const ours = envelopeOf(requirement).extensions?.[KEY] as { info: object };
  return { [KEY]: { ...ours, info: { ...ours.info, ...info } } };
}

function proof(
  requirement: PaymentRequirement,
  extensions?: Record<string, unknown>,
  value?: string,
): Promise<string> {
  return createPaymentProof({
    buyerPrivateKey: BUYER_PRIVATE_KEY,
    accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    ...(extensions !== undefined ? { extensions } : {}),
    overrides: { nonce: NONCE, validBefore: 1_900_000_000, ...(value ? { value } : {}) },
  });
}

async function retryKeyOf(resource: CommerceResource, extensions?: Record<string, unknown>) {
  const provider = makeProvider();
  const requirement = await challengeFor(provider, OPTIONAL);
  const payload = await proof(requirement, extensions);
  return () => provider.retryKey?.({ resource, submission: { method: 'x402', payload } });
}

async function verified(
  provider: ReturnType<typeof makeProvider>,
  resource: CommerceResource,
  requirement: PaymentRequirement,
  payload: string,
) {
  return provider.verify({
    requestId: 'req-1',
    resource,
    requirement,
    submission: { method: 'x402', payload },
  });
}

describe('payment-identifier: the challenge', () => {
  it.each([false, true])(
    'declares the extension as the spec writes it, required %s',
    async (required) => {
      const requirement = await challengeFor(makeProvider(), required ? REQUIRED : OPTIONAL);

      expect(envelopeOf(requirement).extensions).toEqual({ [KEY]: declared(required) });
    },
  );

  it('declares it beside the ERC-8409 quote extension', async () => {
    const provider = makeProvider({ quote: { signerPrivateKey: QUOTE_KEY } });
    const quoteKey = provider.quote?.extension ?? '';

    const extensions = envelopeOf(await challengeFor(provider, OPTIONAL)).extensions ?? {};

    expect(Object.keys(extensions).sort()).toEqual([quoteKey, KEY].sort());
    expect(extensions[KEY]).toEqual(declared(false));
    expect(extensions[quoteKey]).toMatchObject({ info: { quotes: [expect.anything()] } });
  });

  it('leaves the challenge unchanged on a resource that stores no responses', async () => {
    const provider = makeProvider();
    const merchantKeyOnly = { ...PLAIN, idempotency: { merchantKey: true } };

    const plain = await challengeFor(provider, PLAIN);
    const other = await challengeFor(provider, merchantKeyOnly);

    expect(JSON.stringify(other.challenge)).toBe(JSON.stringify(plain.challenge));
    expect(plain.challenge.envelope).not.toHaveProperty('extensions');
  });

  it('leaves the quote extension alone on a resource that stores no responses', async () => {
    const provider = makeProvider({ quote: { signerPrivateKey: QUOTE_KEY } });

    const extensions = envelopeOf(await challengeFor(provider, PLAIN)).extensions ?? {};

    expect(Object.keys(extensions)).toEqual([provider.quote?.extension]);
  });

  it('gives each challenge its own declaration', async () => {
    const provider = makeProvider();
    const first = await challengeFor(provider, OPTIONAL);
    const ours = envelopeOf(first).extensions as Record<string, { info: Record<string, unknown> }>;
    (ours[KEY] as { info: Record<string, unknown> }).info['id'] = 'x';

    const second = await challengeFor(provider, OPTIONAL);

    expect(envelopeOf(second).extensions?.[KEY]).toEqual(declared(false));
  });
});

describe('payment-identifier: the retry key', () => {
  it("reads the buyer's id", async () => {
    const read = await retryKeyOf(
      OPTIONAL,
      echo(await challengeFor(makeProvider(), OPTIONAL), {
        id: PINNED_ID,
      }),
    );

    expect(read()).toBe(PINNED_ID);
  });

  it('reads no key on a resource that stores no responses', async () => {
    const read = await retryKeyOf(PLAIN, { [KEY]: { info: { required: false, id: PINNED_ID } } });

    expect(read()).toBeUndefined();
  });

  it.each([
    ['a stored response is optional', OPTIONAL],
    ['the id is required', REQUIRED],
  ])('reads no key from a proof that does not decode, when %s', (_name, resource) => {
    const provider = makeProvider();

    const key = provider.retryKey?.({ resource, submission: { method: 'x402', payload: '%%%' } });

    expect(key).toBeUndefined();
  });

  it.each([
    ['no extension', undefined],
    ['an echo with no id', { [KEY]: { info: { required: false } } }],
  ])('reads no key from %s when the id is optional', async (_name, extensions) => {
    const read = await retryKeyOf(OPTIONAL, extensions);

    expect(read()).toBeUndefined();
  });

  it.each([
    ['no extension', undefined],
    ['an echo with no id', { [KEY]: { info: { required: true } } }],
  ])('refuses %s with 400 when the id is required', async (_name, extensions) => {
    const read = await retryKeyOf(REQUIRED, extensions);

    expect(read).toThrow(
      expect.objectContaining({
        code: 'INPUT_INVALID',
        httpStatus: 400,
        resourceId: 'demo.report',
        details: { reason: 'payment_identifier_required' },
      }),
    );
  });

  it.each([
    [16, 'a'.repeat(16)],
    [128, 'Z_-9'.repeat(32)],
  ])('accepts an id of %i characters', async (_length, id) => {
    const read = await retryKeyOf(OPTIONAL, { [KEY]: { info: { required: false, id } } });

    expect(read()).toBe(id);
  });

  it.each([
    ['15 characters', 'a'.repeat(15)],
    ['129 characters', 'a'.repeat(129)],
    ['a dot', `${'a'.repeat(15)}.`],
    ['a space', `${'a'.repeat(15)} `],
    ['a letter outside ASCII', `${'a'.repeat(15)}é`],
    ['a number', 1234567890123456],
    ['null', null],
  ])('refuses an id with %s', async (_name, id) => {
    const read = await retryKeyOf(OPTIONAL, { [KEY]: { info: { required: false, id } } });

    expect(read).toThrow(
      expect.objectContaining({
        code: 'INPUT_INVALID',
        details: { reason: 'payment_identifier_invalid' },
      }),
    );
  });

  it.each([
    ['an extension that is not an object', { [KEY]: true }],
    ['info that is not an object', { [KEY]: { info: PINNED_ID } }],
    ['no info', { [KEY]: { id: PINNED_ID } }],
  ])('refuses %s', async (_name, extensions) => {
    const read = await retryKeyOf(OPTIONAL, extensions);

    expect(read).toThrow(
      expect.objectContaining({ details: { reason: 'payment_identifier_invalid' } }),
    );
  });

  it('puts no part of the id in its error', async () => {
    const id = `${PINNED_ID}!`;
    const read = await retryKeyOf(OPTIONAL, { [KEY]: { info: { required: false, id } } });

    expect(read).toThrow(expect.not.objectContaining({ message: expect.stringContaining(id) }));
  });
});

describe('payment-identifier: the echo check', () => {
  it.each([
    ['adds the id', { id: PINNED_ID }],
    ['adds another info field', { id: PINNED_ID, note: 'retry 1' }],
  ])('verifies an echo that %s', async (_name, info) => {
    const provider = makeProvider();
    const requirement = await challengeFor(provider, OPTIONAL);

    const result = await verified(
      provider,
      OPTIONAL,
      requirement,
      await proof(requirement, echo(requirement, info)),
    );

    expect(result).toMatchObject({ status: 'verified', payer: BUYER });
    expect(facilitator.requests).toEqual(['POST /verify']);
  });

  it.each([
    ['changes required', { required: true, id: PINNED_ID }],
    ['drops required', { required: undefined, id: PINNED_ID }],
  ])('refuses an echo that %s, before the facilitator', async (_name, info) => {
    const provider = makeProvider();
    const requirement = await challengeFor(provider, OPTIONAL);

    const result = await verified(
      provider,
      OPTIONAL,
      requirement,
      await proof(requirement, echo(requirement, info)),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      rejectionReason: 'extension_echo_mismatch',
      replayKey: expect.any(String),
    });
    expect(facilitator.requests).toEqual([]);
  });

  it('refuses an echo with no info', async () => {
    const provider = makeProvider();
    const requirement = await challengeFor(provider, OPTIONAL);

    const result = await verified(
      provider,
      OPTIONAL,
      requirement,
      await proof(requirement, { [KEY]: { id: PINNED_ID } }),
    );

    expect(result.rejectionReason).toBe('extension_echo_mismatch');
  });

  it('verifies a proof that echoes no extension', async () => {
    const provider = makeProvider();
    const requirement = await challengeFor(provider, OPTIONAL);

    const result = await verified(provider, OPTIONAL, requirement, await proof(requirement));

    expect(result.status).toBe('verified');
  });

  it('verifies a proof that echoes the identifier but not the quotes', async () => {
    const provider = makeProvider({ quote: { signerPrivateKey: QUOTE_KEY } });
    const requirement = await challengeFor(provider, OPTIONAL);

    const result = await verified(
      provider,
      OPTIONAL,
      requirement,
      await proof(requirement, echo(requirement, { id: PINNED_ID })),
    );

    expect(result.status).toBe('verified');
  });

  it('ignores an identifier the challenge did not declare', async () => {
    const provider = makeProvider();
    const requirement = await challengeFor(provider, PLAIN);

    const result = await verified(
      provider,
      PLAIN,
      requirement,
      await proof(requirement, { [KEY]: { info: { required: true, id: PINNED_ID } } }),
    );

    expect(result.status).toBe('verified');
  });
});

describe('payment-identifier: proofs from other sources', () => {
  it('reads and verifies a proof from the SDK client with a pinned id', async () => {
    const provider = makeProvider();
    const requirement = await challengeFor(provider, REQUIRED);
    const client = new x402Client();
    registerExactEvmScheme(client, {
      signer: privateKeyToAccount(BUYER_PRIVATE_KEY),
      networks: ['eip155:31337'],
    });
    // MockUSDC is not in the SDK's asset list, so its spend controls are off
    client.setSpendControls(false);
    // Add the purchase's ID before the SDK echoes the declaration into the proof
    client.onBeforePaymentCreation(async ({ paymentRequired }) => {
      const extensions = paymentRequired.extensions as Record<string, { info: object }>;
      Object.assign((extensions[KEY] as { info: object }).info, { id: PINNED_ID });
    });
    const signed = await client.createPaymentPayload(structuredClone(envelopeOf(requirement)));
    const payload = Buffer.from(JSON.stringify(signed), 'utf8').toString('base64');

    const key = provider.retryKey?.({
      resource: REQUIRED,
      submission: { method: 'x402', payload },
    });
    const result = await verified(provider, REQUIRED, requirement, payload);

    expect(key).toBe(PINNED_ID);
    expect(result.status).toBe('verified');
  });

  it('refuses a proof signed for another amount, whatever id it carries', async () => {
    const provider = makeProvider();
    const requirement = await challengeFor(provider, OPTIONAL);
    const payload = await proof(requirement, echo(requirement, { id: PINNED_ID }), '1');

    const key = provider.retryKey?.({
      resource: OPTIONAL,
      submission: { method: 'x402', payload },
    });
    const result = await verified(provider, OPTIONAL, requirement, payload);

    expect(key).toBe(PINNED_ID);
    expect(result.status).toBe('rejected');
    expect(facilitator.requests).toEqual([]);
  });

  it('sends the facilitator no part of the extension', async () => {
    const provider = makeProvider();
    const requirement = await challengeFor(provider, OPTIONAL);
    const payload = await proof(requirement, echo(requirement, { id: PINNED_ID }));
    const context = {
      requestId: 'req-1',
      resource: OPTIONAL,
      requirement,
      submission: { method: 'x402' as const, payload },
    };

    const verification = await provider.verify(context);
    const settlement = await provider.settle({ ...context, verification });

    expect(settlement.status).toBe('settled');
    expect(facilitator.requests).toEqual(['POST /verify', 'POST /settle']);
    for (const body of facilitator.bodies) {
      expect(body).not.toContain(PINNED_ID);
      expect(body).not.toContain(KEY);
    }
  });
});

describe('x402ErrorCode', () => {
  it.each([
    ['PAYMENT_REPLAYED', 'payment_identifier_conflict'],
    ['PAYMENT_REPLAYED', 'payment_identifier_in_flight'],
    ['PAYMENT_REPLAYED', 'payment_identifier_unresolved'],
    ['INPUT_INVALID', 'payment_identifier_required'],
    ['INPUT_INVALID', 'payment_identifier_invalid'],
  ])('answers %s with its reason %s', (code, reason) => {
    expect(x402ErrorCode(code, reason, 'solana:devnet')).toBe(reason);
  });

  it.each([
    ['eip155:8453', 'invalid_exact_evm_nonce_already_used'],
    ['solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', 'duplicate_settlement'],
    ['near:mainnet', 'invalid_exact_near_payload_delegate_action_nonce_already_used'],
    [undefined, 'invalid_exact_evm_nonce_already_used'],
  ])("keeps a spent authorization's replay code on %s", (network, expected) => {
    expect(x402ErrorCode('PAYMENT_REPLAYED', 'PAYMENT_REPLAYED', network)).toBe(expected);
  });

  it('keeps other refusal reasons', () => {
    expect(x402ErrorCode('PAYMENT_INVALID', 'extension_echo_mismatch')).toBe(
      'extension_echo_mismatch',
    );
    expect(x402ErrorCode('PAYMENT_INVALID', undefined)).toBe('unexpected_verify_error');
  });
});

describe('createPaymentProof: extensions', () => {
  async function proofs() {
    const requirement = await challengeFor(makeProvider(), OPTIONAL);
    const extensions = echo(requirement, { id: PINNED_ID });
    const decode = (payload: string) =>
      JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Record<string, unknown>;
    return {
      extensions,
      without: await proof(requirement),
      with: await proof(requirement, extensions),
      decode,
    };
  }

  it('writes the same proof as before without them', async () => {
    const { without, decode } = await proofs();

    expect(Object.keys(decode(without))).toEqual(['x402Version', 'accepted', 'payload']);
  });

  it('adds them outside the signature', async () => {
    const { without, with: carrying, extensions, decode } = await proofs();

    expect(decode(carrying)).toEqual({ ...decode(without), extensions });
  });

  it('keeps the id through decodePaymentSubmission', async () => {
    const { with: carrying } = await proofs();

    expect(decodePaymentSubmission(carrying)?.extensions?.[KEY]).toMatchObject({
      info: { required: false, id: PINNED_ID },
    });
  });
});
