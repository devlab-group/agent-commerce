import { describe, expect, it } from 'vitest';
import type {
  CommerceResource,
  PaymentContext,
  PaymentVerificationContext,
} from '../../../src/core/index.js';
import { isCommerceError } from '../../../src/core/index.js';
import { createPaymentProof } from '../../../src/payments/x402/client.js';
import {
  createX402PaymentProvider,
  type X402ProviderOptions,
} from '../../../src/payments/x402/provider.js';

// A plausible-looking RPC URL nobody is listening on — connection refuses
// immediately, letting us exercise the "provider unavailable" path without
// booting a real chain (that happens in tests/e2e/payment).
const UNREACHABLE_RPC_URL = 'http://127.0.0.1:18999';

const ASSET = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;
const PAY_TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
const BUYER_PRIVATE_KEY =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;

function makeProvider(overrides: Partial<X402ProviderOptions> = {}) {
  return createX402PaymentProvider({
    network: 'base-sepolia',
    rpcUrl: UNREACHABLE_RPC_URL,
    asset: ASSET,
    assetName: 'MockUSDC',
    assetVersion: '2',
    assetDecimals: 6,
    payTo: PAY_TO,
    facilitator: { mode: 'local', signerPrivateKey: BUYER_PRIVATE_KEY },
    ...overrides,
  });
}

const RESOURCE: CommerceResource = {
  id: 'demo.report',
  name: 'Demo report',
  description: 'A paid demo report',
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
    requestedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('descriptor', () => {
  it('is honest about what is and is not supported', () => {
    const provider = makeProvider();
    expect(provider.name).toBe('x402');
    expect(provider.descriptor.name).toBe('x402');
    expect(provider.descriptor.kind).toBe('payment');
    expect(provider.descriptor.status).toBe('stable');
    expect(provider.descriptor.supportedSpec).toContain('x402@1.2.0');
    expect(provider.descriptor.capabilities).toContain('exact-evm');
    expect(provider.descriptor.capabilities).toContain('eip-3009');
    // Alpha honesty: things this provider does NOT implement must be listed.
    expect(provider.descriptor.unsupported).toContain('svm');
    expect(provider.descriptor.unsupported).toContain('remote facilitator');
  });
});

describe('createRequirement', () => {
  it('builds an x402 PaymentRequirements object with base-unit maxAmountRequired', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());

    expect(requirement.provider).toBe('x402');
    expect(requirement.resourceId).toBe('demo.report');
    expect(requirement.requestId).toBe('req-1');
    expect(requirement.amount).toBe('0.01');
    expect(requirement.destination).toBe(PAY_TO);
    expect(requirement.network).toBe('base-sepolia');
    expect(requirement.asset).toBe(ASSET);
    expect(requirement.challenge.provider).toBe('x402');
    expect(requirement.challenge.accepts).toHaveLength(1);

    const accepted = requirement.challenge.accepts[0] as Record<string, unknown>;
    expect(accepted['scheme']).toBe('exact');
    expect(accepted['network']).toBe('base-sepolia');
    expect(accepted['maxAmountRequired']).toBe('10000'); // 0.01 * 10^6
    expect(accepted['payTo']).toBe(PAY_TO);
    expect(accepted['asset']).toBe(ASSET);
    // extra.name/version is REQUIRED — the facilitator must never
    // need an on-chain version() call to build the EIP-712 domain.
    expect(accepted['extra']).toEqual({ name: 'MockUSDC', version: '2' });
  });

  it('sets an expiresAt in the future, bounded by maxTimeoutSeconds', async () => {
    const provider = makeProvider({ maxTimeoutSeconds: 30 });
    const before = Date.now();
    const requirement = await provider.createRequirement(paymentContext());
    expect(requirement.expiresAt).toBeDefined();
    const expiresAtMs = Date.parse(requirement.expiresAt as string);
    expect(expiresAtMs).toBeGreaterThan(before);
    expect(expiresAtMs).toBeLessThanOrEqual(before + 30_000 + 1000);
  });

  it('produces a distinct id per call', async () => {
    const provider = makeProvider();
    const a = await provider.createRequirement(paymentContext());
    const b = await provider.createRequirement(paymentContext());
    expect(a.id).not.toBe(b.id);
  });
});

describe('verify — rejects before touching the network', () => {
  it('rejects a payload that is not valid base64/JSON', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: '!!! not base64 or json !!!' },
    });
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('malformed_payment_payload');
  });

  it('rejects valid base64 that decodes to non-JSON', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const payload = Buffer.from('this is not json{{{').toString('base64');
    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload },
    });
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('malformed_payment_payload');
  });

  it('rejects valid JSON that does not match the x402 PaymentPayload schema', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const payload = Buffer.from(JSON.stringify({ hello: 'world' })).toString('base64');
    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload },
    });
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('malformed_payment_payload');
  });

  it('rejects an empty string payload', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: '' },
    });
    expect(result.status).toBe('rejected');
  });

  it('rejects when the requirement has already expired', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const expired = { ...requirement, expiresAt: new Date(Date.now() - 60_000).toISOString() };
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: UNREACHABLE_RPC_URL,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });
    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement: expired,
      submission: { method: 'x402', payload: proof },
    });
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('requirement_expired');
  });

  it('rejects when the requirement was generated for a different provider', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const tampered = { ...requirement, provider: 'other' as never };
    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement: tampered,
      submission: { method: 'x402', payload: 'anything' },
    });
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('wrong_provider');
  });

  it('rejects when the configured asset does not match the requirement asset (defensive invariant)', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const accepted = requirement.challenge.accepts[0] as Record<string, unknown>;
    const tampered = {
      ...requirement,
      challenge: {
        ...requirement.challenge,
        accepts: [{ ...accepted, asset: '0x00000000000000000000000000000000000000dd' }],
      },
    };
    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement: tampered,
      submission: { method: 'x402', payload: 'anything' },
    });
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('wrong_asset');
  });

  it('rejects the wrong network', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: UNREACHABLE_RPC_URL,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });
    // Decode, tamper with the network, re-encode using the same wire format.
    const decoded = JSON.parse(Buffer.from(proof, 'base64').toString('utf8'));
    decoded.network = 'base';
    const tamperedProof = Buffer.from(JSON.stringify(decoded)).toString('base64');

    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: tamperedProof },
    });
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('wrong_network');
  });

  it('rejects the wrong recipient', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: UNREACHABLE_RPC_URL,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
      overrides: { payTo: '0x00000000000000000000000000000000000000ee' },
    });
    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
    });
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('wrong_recipient');
  });

  it('rejects a value below maxAmountRequired', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: UNREACHABLE_RPC_URL,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
      overrides: { value: '1' }, // far less than the required 10000
    });
    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
    });
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('wrong_amount');
  });

  it('rejects a value that is not a valid integer string (malformed authorization)', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: UNREACHABLE_RPC_URL,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });
    const decoded = JSON.parse(Buffer.from(proof, 'base64').toString('utf8'));
    decoded.payload.authorization.value = 'not-a-number';
    const tamperedProof = Buffer.from(JSON.stringify(decoded)).toString('base64');

    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: tamperedProof },
    });
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('malformed_payment_payload');
  });

  it('rejects a malformed "from" address in the authorisation', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: UNREACHABLE_RPC_URL,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });
    const decoded = JSON.parse(Buffer.from(proof, 'base64').toString('utf8'));
    decoded.payload.authorization.from = 'not-an-address';
    const tamperedProof = Buffer.from(JSON.stringify(decoded)).toString('base64');

    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: tamperedProof },
    });
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('malformed_payment_payload');
  });

  it('rejects an SVM-shaped payload (unsupported scheme for this provider)', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const svmPayload = {
      x402Version: 1,
      scheme: 'exact',
      network: 'solana',
      payload: { transaction: 'YQ==' },
    };
    const proof = Buffer.from(JSON.stringify(svmPayload)).toString('base64');

    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement,
      submission: { method: 'x402', payload: proof },
    });
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('unsupported_scheme');
  });

  it('omits network/asset from a rejected result when the requirement never had them', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const { network, asset, ...requirementWithoutNetworkOrAsset } = requirement;

    const result = await provider.verify({
      requestId: 'req-1',
      resource: RESOURCE,
      requirement: requirementWithoutNetworkOrAsset,
      submission: { method: 'x402', payload: 'garbage' },
    });
    expect(result.status).toBe('rejected');
    expect(result.network).toBeUndefined();
    expect(result.asset).toBeUndefined();
  });

  it('never throws for a garbage submission — always returns a rejected result', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());
    const verifyOnce = (payload: string) =>
      provider.verify({
        requestId: 'req-1',
        resource: RESOURCE,
        requirement,
        submission: { method: 'x402', payload },
      } satisfies PaymentVerificationContext);

    for (const garbage of [
      '',
      'not-base64-or-json!!',
      Buffer.from('null').toString('base64'),
      Buffer.from('[]').toString('base64'),
    ]) {
      await expect(verifyOnce(garbage)).resolves.toMatchObject({ status: 'rejected' });
    }
  });
});

describe('verify — provider unavailable', () => {
  it('throws PAYMENT_PROVIDER_UNAVAILABLE when the RPC is unreachable for an otherwise well-formed payload', async () => {
    const provider = makeProvider(); // rpcUrl points at nothing listening
    const requirement = await provider.createRequirement(paymentContext());
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: UNREACHABLE_RPC_URL,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });

    await expect(
      provider.verify({
        requestId: 'req-1',
        resource: RESOURCE,
        requirement,
        submission: { method: 'x402', payload: proof },
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
    );
  });
});

describe('createX402PaymentProvider — payTo dev-address guard', () => {
  const PUBLIC_RPC_URL = 'https://mainnet.base.org';
  const DEV_PAY_TO = PAY_TO; // fixture PAY_TO is a well-known Anvil address
  const REAL_PAY_TO = `0x${'f0'.repeat(20)}` as const;
  // Deliberately NOT a well-known Anvil key, so this isolates the payTo
  // guard from assertDevKeyIsLocalOnly — the "own facilitator key + dev
  // payTo" case.
  const REAL_FACILITATOR_KEY = `0x${'22'.repeat(32)}` as const;

  it("throws CONFIG_INVALID for a dev payTo against a public RPC, even with the operator's own facilitator key", () => {
    expect(() =>
      makeProvider({
        rpcUrl: PUBLIC_RPC_URL,
        payTo: DEV_PAY_TO,
        facilitator: { mode: 'local', signerPrivateKey: REAL_FACILITATOR_KEY },
      }),
    ).toThrow();
    try {
      makeProvider({
        rpcUrl: PUBLIC_RPC_URL,
        payTo: DEV_PAY_TO,
        facilitator: { mode: 'local', signerPrivateKey: REAL_FACILITATOR_KEY },
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(isCommerceError(err)).toBe(true);
      if (isCommerceError(err)) expect(err.code).toBe('CONFIG_INVALID');
    }
  });

  it('throws CONFIG_INVALID for a dev payTo against a public RPC even with a remote facilitator', () => {
    // The case this covers: an operator who brings their own
    // facilitator key (so assertDevKeyIsLocalOnly has nothing to say) but
    // forgets to change payTo away from the local-demo default. The
    // destination guard must not depend on facilitator.mode.
    expect(() =>
      makeProvider({
        rpcUrl: PUBLIC_RPC_URL,
        payTo: DEV_PAY_TO,
        facilitator: { mode: 'remote', url: 'https://facilitator.invalid' },
      }),
    ).toThrow();
    try {
      makeProvider({
        rpcUrl: PUBLIC_RPC_URL,
        payTo: DEV_PAY_TO,
        facilitator: { mode: 'remote', url: 'https://facilitator.invalid' },
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(isCommerceError(err)).toBe(true);
      if (isCommerceError(err)) expect(err.code).toBe('CONFIG_INVALID');
    }
  });

  it('accepts a real (non-dev) payTo against a public RPC — the correct configuration', () => {
    expect(() =>
      makeProvider({
        rpcUrl: PUBLIC_RPC_URL,
        payTo: REAL_PAY_TO,
        facilitator: { mode: 'local', signerPrivateKey: REAL_FACILITATOR_KEY },
      }),
    ).not.toThrow();
  });
});

describe('settle — remote facilitator is not implemented', () => {
  it('throws PROTOCOL_UNSUPPORTED for mode: "remote", without attempting settlement', async () => {
    const provider = makeProvider({
      facilitator: { mode: 'remote', url: 'https://facilitator.invalid' },
    });
    const requirement = await provider.createRequirement(paymentContext());

    await expect(
      provider.settle({
        requestId: 'req-1',
        resource: RESOURCE,
        requirement,
        submission: { method: 'x402', payload: 'irrelevant' },
        verification: {
          status: 'verified',
          provider: 'x402',
          amount: '0.01',
          currency: 'USD',
        },
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isCommerceError(err) && err.code === 'PROTOCOL_UNSUPPORTED',
    );
  });

  it('throws PAYMENT_INVALID if settle() is called without a successful verify()', async () => {
    const provider = makeProvider();
    const requirement = await provider.createRequirement(paymentContext());

    await expect(
      provider.settle({
        requestId: 'req-1',
        resource: RESOURCE,
        requirement,
        submission: { method: 'x402', payload: 'irrelevant' },
        verification: {
          status: 'rejected',
          provider: 'x402',
          amount: '0.01',
          currency: 'USD',
          rejectionReason: 'wrong_amount',
        },
      }),
    ).rejects.toSatisfy((err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_INVALID');
  });
});

describe('health', () => {
  it('never throws, and reports fail when the RPC is unreachable', async () => {
    const provider = makeProvider();
    const health = await provider.health();
    expect(health.status).toBe('fail');
    expect(health.detail).toBeDefined();
    expect(health.checkedAt).toBeDefined();
  });

  it('rejects an invalid asset address at construction time (fail closed on bad config)', () => {
    expect(() => makeProvider({ asset: 'not-an-address' as `0x${string}` })).toThrow();
  });

  it('rejects an invalid payTo address at construction time', () => {
    expect(() => makeProvider({ payTo: 'not-an-address' as `0x${string}` })).toThrow();
  });
});
