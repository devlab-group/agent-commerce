// Options of every family resolve here, before config load applies its guardrails
import { describe, expect, it } from 'vitest';
import { resolveX402Option } from '../../../src/payments/x402/options';

const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const SOLANA_PAYEE = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const NEAR_TESTNET = 'near:testnet';
const NEAR_PAYEE = 'merchant.testnet';

describe('resolveX402Option', () => {
  it('fills a Solana option from the network USDC mint, with no EIP-712 domain', () => {
    const option = resolveX402Option({ network: SOLANA_DEVNET, payTo: SOLANA_PAYEE }, 'opt');
    expect(option).toMatchObject({
      scheme: 'exact',
      payTo: SOLANA_PAYEE,
      asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      assetDecimals: 6,
      defaultAssetSymbol: 'USDC',
    });
    expect(option.network.family).toBe('svm');
    expect(option.assetName).toBeUndefined();
  });

  it('refuses an EIP-712 domain on a Solana option', () => {
    expect(() =>
      resolveX402Option({ network: SOLANA_DEVNET, payTo: SOLANA_PAYEE, assetName: 'USDC' }, 'opt'),
    ).toThrow(/EVM tokens only/);
  });

  it('fills a NEAR option from the network USDC contract, an implicit account', () => {
    const option = resolveX402Option({ network: NEAR_TESTNET, payTo: NEAR_PAYEE }, 'opt');
    expect(option).toMatchObject({
      payTo: NEAR_PAYEE,
      asset: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
      assetDecimals: 6,
      defaultAssetSymbol: 'USDC',
    });
    expect(option.network.family).toBe('near');
  });

  it('refuses a payee that is not a NEAR account ID, and an EIP-712 domain', () => {
    expect(() =>
      resolveX402Option({ network: NEAR_TESTNET, payTo: 'Merchant.testnet' }, 'opt'),
    ).toThrow(/NEAR account ID/);
    expect(() =>
      resolveX402Option({ network: NEAR_TESTNET, payTo: NEAR_PAYEE, assetVersion: '1' }, 'opt'),
    ).toThrow(/EVM tokens only/);
  });

  it('needs decimals for a token other than the default', () => {
    expect(() =>
      resolveX402Option({ network: NEAR_TESTNET, payTo: NEAR_PAYEE, asset: 'usdt.testnet' }, 'opt'),
    ).toThrow(/needs assetDecimals/);
  });

  describe('assetTransferMethod', () => {
    const LOCAL = {
      network: 'eip155:31337',
      payTo: '0x1111111111111111111111111111111111111111',
      asset: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      assetDecimals: 18,
    };

    it('needs no EIP-712 domain for a Permit2 token', () => {
      const option = resolveX402Option({ ...LOCAL, assetTransferMethod: 'permit2' }, 'opt');
      expect(option.assetTransferMethod).toBe('permit2');
      expect(option.assetName).toBeUndefined();
    });

    it('still needs the domain for an EIP-3009 token, the default method', () => {
      expect(() => resolveX402Option(LOCAL, 'opt')).toThrow(/assetName/);
    });

    it('refuses an unknown method and any method off EVM', () => {
      expect(() => resolveX402Option({ ...LOCAL, assetTransferMethod: 'permit' }, 'opt')).toThrow(
        /opt\.assetTransferMethod: "permit" is not supported/,
      );
      expect(() =>
        resolveX402Option(
          { network: SOLANA_DEVNET, payTo: SOLANA_PAYEE, assetTransferMethod: 'permit2' },
          'opt',
        ),
      ).toThrow(/EVM networks only/);
    });
  });
});
