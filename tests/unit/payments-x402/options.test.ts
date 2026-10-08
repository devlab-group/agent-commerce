// Solana and TON options resolve here, although config load refuses them until their providers exist
import { Address } from '@ton/core';
import { describe, expect, it } from 'vitest';
import { resolveX402Option } from '../../../src/payments/x402/options';

const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const SOLANA_PAYEE = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const TON_TESTNET = 'tvm:-3';
const TON_PAYEE_RAW = `0:${'ab'.repeat(32)}`;

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

  it('carries a TON payee in raw form, whichever form it was given in', () => {
    const friendly = Address.parse(TON_PAYEE_RAW).toString({ testOnly: true });
    const option = resolveX402Option({ network: TON_TESTNET, payTo: friendly }, 'opt');
    expect(option).toMatchObject({
      payTo: TON_PAYEE_RAW,
      assetDecimals: 6,
      defaultAssetSymbol: 'USDT',
    });
  });

  it('needs decimals for a jetton other than the default', () => {
    expect(() =>
      resolveX402Option(
        { network: TON_TESTNET, payTo: TON_PAYEE_RAW, asset: `0:${'cd'.repeat(32)}` },
        'opt',
      ),
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
