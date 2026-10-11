import { KeyPair } from '@near-js/crypto';
import { actionCreators } from '@near-js/transactions';
import { describe, expect, it } from 'vitest';
import { inspectNearPayload, type NearTransferTerms } from '../../../src/payments/x402/near';
import { computeNearReplayKey } from '../../../src/payments/x402/replay-key';
import { buildSignedDelegate, DELEGATE_DEFAULTS } from '../../fixtures/x402/near-delegate';

const TERMS: NearTransferTerms = {
  network: 'near:testnet',
  asset: DELEGATE_DEFAULTS.receiverId,
  payTo: DELEGATE_DEFAULTS.ftReceiver,
  amount: DELEGATE_DEFAULTS.amount,
};

const inspect = (signedDelegateAction: unknown, terms = TERMS) =>
  inspectNearPayload({ signedDelegateAction }, terms);

describe('inspectNearPayload', () => {
  it('reads the payer and keys the payment by sender, key and nonce', async () => {
    const { signedDelegateAction, keyPair } = await buildSignedDelegate();
    expect(inspect(signedDelegateAction)).toEqual({
      payer: DELEGATE_DEFAULTS.senderId,
      replayKey: computeNearReplayKey({
        network: 'near:testnet',
        senderId: DELEGATE_DEFAULTS.senderId,
        publicKey: keyPair.getPublicKey().toString(),
        nonce: DELEGATE_DEFAULTS.nonce,
      }),
    });
  });

  it('reads a secp256k1 key with its curve', async () => {
    const keyPair = KeyPair.fromRandom('secp256k1');
    const { signedDelegateAction } = await buildSignedDelegate({ keyPair });
    expect(keyPair.getPublicKey().toString()).toMatch(/^secp256k1:/);
    expect(inspect(signedDelegateAction)).toMatchObject({ payer: DELEGATE_DEFAULTS.senderId });
  });

  it('gives the same key to another delegate of the same sender, key and nonce', async () => {
    // NEAR consumes the nonce, whatever else the delegate says
    const keyPair = KeyPair.fromRandom('ed25519');
    const first = await buildSignedDelegate({ keyPair });
    const other = await buildSignedDelegate({ keyPair, gas: 40_000_000_000_000n });
    const otherAsset = await buildSignedDelegate({ keyPair, receiverId: 'usdt.testnet' });
    const key = (inspect(first.signedDelegateAction) as { replayKey: string }).replayKey;
    expect((inspect(other.signedDelegateAction) as { replayKey: string }).replayKey).toBe(key);
    expect(
      (
        inspect(otherAsset.signedDelegateAction, { ...TERMS, asset: 'usdt.testnet' }) as {
          replayKey: string;
        }
      ).replayKey,
    ).toBe(key);
  });

  it('keeps another access key, nonce or network apart', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    const key = (
      inspect((await buildSignedDelegate({ keyPair })).signedDelegateAction) as {
        replayKey: string;
      }
    ).replayKey;
    const otherKey = await buildSignedDelegate();
    const otherNonce = await buildSignedDelegate({ keyPair, nonce: 6n });
    const mainnet = inspect((await buildSignedDelegate({ keyPair })).signedDelegateAction, {
      ...TERMS,
      network: 'near:mainnet',
    });
    for (const result of [
      inspect(otherKey.signedDelegateAction),
      inspect(otherNonce.signedDelegateAction),
      mainnet,
    ]) {
      expect((result as { replayKey: string }).replayKey).not.toBe(key);
    }
  });

  it.each<[string, Parameters<typeof buildSignedDelegate>[0], string]>([
    [
      'another token contract',
      { receiverId: 'usdt.testnet' },
      'invalid_exact_near_payload_token_contract_mismatch',
    ],
    [
      'another recipient',
      { ftReceiver: 'attacker.testnet' },
      'invalid_exact_near_payload_recipient_mismatch',
    ],
    ['a smaller amount', { amount: '9999' }, 'invalid_exact_near_payload_amount_mismatch'],
    ['a padded amount', { amount: '010000' }, 'invalid_exact_near_payload_amount_mismatch'],
    [
      'another method',
      { methodName: 'ft_transfer_call' },
      'invalid_exact_near_payload_method_name',
    ],
    ['no deposit', { deposit: 0n }, 'invalid_exact_near_payload_attached_deposit'],
    ['two yoctoNEAR', { deposit: 2n }, 'invalid_exact_near_payload_attached_deposit'],
  ])('refuses %s', async (_label, options, reason) => {
    expect(inspect((await buildSignedDelegate(options)).signedDelegateAction)).toBe(reason);
  });

  it('refuses an extra action, a non-call action and no action', async () => {
    const transfer = actionCreators.functionCall(
      'ft_transfer',
      { receiver_id: TERMS.payTo, amount: TERMS.amount },
      30_000_000_000_000n,
      1n,
    );
    expect(
      inspect((await buildSignedDelegate({ actions: [transfer, transfer] })).signedDelegateAction),
    ).toBe('invalid_exact_near_payload_action_count');
    expect(
      inspect(
        (await buildSignedDelegate({ actions: [actionCreators.transfer(1n)] }))
          .signedDelegateAction,
      ),
    ).toBe('invalid_exact_near_payload_action_kind');
    expect(inspect((await buildSignedDelegate({ actions: [] })).signedDelegateAction)).toBe(
      'invalid_exact_near_payload_action_count',
    );
  });

  it('refuses arguments that are not an ft_transfer', async () => {
    const call = actionCreators.functionCall('ft_transfer', { amount: TERMS.amount }, 30n, 1n);
    expect(inspect((await buildSignedDelegate({ actions: [call] })).signedDelegateAction)).toBe(
      'invalid_exact_near_payload_ft_transfer_args',
    );
  });

  it('refuses a payload that is not one bounded, decodable signed delegate', async () => {
    const { signedDelegateAction } = await buildSignedDelegate();
    const bytes = Buffer.from(signedDelegateAction, 'base64');
    expect(inspectNearPayload('x', TERMS)).toBe('invalid_exact_near_payload_shape');
    expect(inspectNearPayload({}, TERMS)).toBe('invalid_exact_near_payload_shape');
    expect(inspect('A'.repeat(4097))).toBe('invalid_exact_near_payload_shape');
    // The same bytes in another base64 spelling
    expect(inspect(signedDelegateAction.replace(/=+$/, ''))).toBe(
      'invalid_exact_near_payload_signed_delegate_action',
    );
    for (const malformed of [
      bytes.subarray(0, bytes.length - 10),
      Buffer.concat([bytes, Buffer.from([0])]),
      Buffer.from('not a delegate'),
    ]) {
      expect(inspect(malformed.toString('base64'))).toBe(
        'invalid_exact_near_payload_signed_delegate_action',
      );
    }
  });
});
