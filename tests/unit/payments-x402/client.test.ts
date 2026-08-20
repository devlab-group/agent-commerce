import { verifyTypedData } from 'viem';
import { describe, expect, it } from 'vitest';
import { createPaymentProof } from '../../../src/payments/x402/client.js';

const BUYER_PRIVATE_KEY =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;
const BUYER_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const ASSET = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;
const PAY_TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;

const ACCEPTS = {
  scheme: 'exact',
  network: 'base-sepolia',
  maxAmountRequired: '10000',
  resource:
    'resource://agent-commerce/base-sepolia/0x0000000000000000000000000000000000000002/resources/demo.report',
  description: 'Demo report',
  mimeType: 'application/json',
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  asset: ASSET,
  extra: { name: 'MockUSDC', version: '2' },
};

function decode(proof: string): {
  x402Version: number;
  scheme: string;
  network: string;
  payload: { signature: `0x${string}`; authorization: Record<string, string> };
} {
  return JSON.parse(Buffer.from(proof, 'base64').toString('utf8'));
}

describe('createPaymentProof', () => {
  it('returns a base64 string decoding to a well-formed x402 PaymentPayload', async () => {
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: 'http://127.0.0.1:1', // unused for the exact/EVM scheme — never contacted
      accepts: ACCEPTS,
    });

    expect(() => Buffer.from(proof, 'base64')).not.toThrow();
    const decoded = decode(proof);
    expect(decoded.scheme).toBe('exact');
    expect(decoded.network).toBe('base-sepolia');
    expect(decoded.payload.authorization.from?.toLowerCase()).toBe(BUYER_ADDRESS.toLowerCase());
    expect(decoded.payload.authorization.to?.toLowerCase()).toBe(PAY_TO.toLowerCase());
    expect(decoded.payload.authorization.value).toBe('10000');
  });

  it('produces a signature that verifies against the EIP-712 domain the provider will check', async () => {
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: 'http://127.0.0.1:1',
      accepts: ACCEPTS,
    });
    const decoded = decode(proof);
    const { authorization, signature } = decoded.payload;
    const from = authorization.from ?? '';
    const to = authorization.to ?? '';
    const value = authorization.value ?? '0';
    const validAfter = authorization.validAfter ?? '0';
    const validBefore = authorization.validBefore ?? '0';
    const nonce = authorization.nonce ?? '';

    const valid = await verifyTypedData({
      address: BUYER_ADDRESS as `0x${string}`,
      domain: {
        name: 'MockUSDC',
        version: '2',
        chainId: 84532,
        verifyingContract: ASSET,
      },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: from as `0x${string}`,
        to: to as `0x${string}`,
        value: BigInt(value),
        validAfter: BigInt(validAfter),
        validBefore: BigInt(validBefore),
        nonce: nonce as `0x${string}`,
      },
      signature,
    } as never);

    expect(valid).toBe(true);
  });

  it('applies a value override', async () => {
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: 'http://127.0.0.1:1',
      accepts: ACCEPTS,
      overrides: { value: '1' },
    });
    expect(decode(proof).payload.authorization.value).toBe('1');
  });

  it('applies a payTo override', async () => {
    const wrongRecipient = '0x00000000000000000000000000000000000000ee';
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: 'http://127.0.0.1:1',
      accepts: ACCEPTS,
      overrides: { payTo: wrongRecipient },
    });
    expect(decode(proof).payload.authorization.to?.toLowerCase()).toBe(
      wrongRecipient.toLowerCase(),
    );
  });

  it('applies a nonce override (used by replay tests)', async () => {
    const nonce = `0x${'ab'.repeat(32)}` as const;
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: 'http://127.0.0.1:1',
      accepts: ACCEPTS,
      overrides: { nonce },
    });
    expect(decode(proof).payload.authorization.nonce).toBe(nonce);
  });

  it('applies validBefore/validAfter overrides (used by the expiry test)', async () => {
    const validBefore = Math.floor(Date.now() / 1000) - 10; // already expired
    const proof = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: 'http://127.0.0.1:1',
      accepts: ACCEPTS,
      overrides: { validBefore },
    });
    expect(decode(proof).payload.authorization.validBefore).toBe(String(validBefore));
  });

  it('generates a fresh random nonce per call when none is supplied', async () => {
    const proofA = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: 'http://127.0.0.1:1',
      accepts: ACCEPTS,
    });
    const proofB = await createPaymentProof({
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      rpcUrl: 'http://127.0.0.1:1',
      accepts: ACCEPTS,
    });
    expect(decode(proofA).payload.authorization.nonce).not.toBe(
      decode(proofB).payload.authorization.nonce,
    );
  });

  it('throws a clear error when extra.name/extra.version are missing', async () => {
    const { extra, ...withoutExtra } = ACCEPTS;
    await expect(
      createPaymentProof({
        buyerPrivateKey: BUYER_PRIVATE_KEY,
        rpcUrl: 'http://127.0.0.1:1',
        accepts: withoutExtra,
      }),
    ).rejects.toThrow(/extra/);
  });
});
