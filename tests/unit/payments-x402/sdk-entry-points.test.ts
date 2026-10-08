/**
 * Check the pinned SDK entry points and behavior used by the multi-network
 * design. Review that design before accepting a pin change that fails these checks.
 */
import { HTTPFacilitatorClient } from '@x402/core/http';
import { x402ResourceServer } from '@x402/core/server';
import type { SchemeNetworkServer } from '@x402/core/types';
import {
  getDefaultAsset as evmDefaultAsset,
  isEIP3009Payload,
  isPermit2Payload,
  PERMIT2_ADDRESS,
  x402ExactPermit2ProxyAddress,
} from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import {
  decodeTransactionFromPayload,
  getDefaultAsset as svmDefaultAsset,
  transactionMessageHash,
} from '@x402/svm';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { normalizeTonAddress, getDefaultAsset as tvmDefaultAsset } from '@x402/tvm';
import { ExactTvmScheme } from '@x402/tvm/exact/server';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_NETWORKS } from '../../../src/payments/x402/networks';

const BASE = 'eip155:8453';
const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const TON_TESTNET = 'tvm:-3';

describe('pinned x402 SDK entry points', () => {
  it('builds and matches offers through the resource server', () => {
    expect(typeof x402ResourceServer.prototype.buildPaymentRequirements).toBe('function');
    expect(typeof x402ResourceServer.prototype.findMatchingRequirements).toBe('function');
    expect(typeof HTTPFacilitatorClient.prototype.getSupported).toBe('function');
  });

  it('tells EIP-3009 from Permit2 payloads and names the canonical Permit2 contracts', () => {
    expect(isEIP3009Payload({ authorization: {} } as never)).toBe(true);
    expect(isPermit2Payload({ permit2Authorization: {} } as never)).toBe(true);
    expect(PERMIT2_ADDRESS).toBe('0x000000000022D473030F116dDEE9F6B43aC78BA3');
    expect(x402ExactPermit2ProxyAddress).toBe('0x402085c248EeA27D92E8b30b2C58ed07f9E20001');
  });

  it('exports what the Solana and TON replay identities read', () => {
    expect(typeof decodeTransactionFromPayload).toBe('function');
    expect(typeof transactionMessageHash).toBe('function');
    expect(normalizeTonAddress('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs')).toBe(
      '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe',
    );
  });

  it('marks only the Solana blockhash hints as dynamic for offer matching', () => {
    // Read as the resource server reads them, through the scheme interface
    const dynamic = (scheme: SchemeNetworkServer) => scheme.dynamicExtraFields;
    expect(dynamic(new ExactSvmScheme())).toEqual(['recentBlockhash', 'lastValidBlockHeight']);
    expect(dynamic(new ExactEvmScheme())).toBeUndefined();
    expect(dynamic(new ExactTvmScheme())).toBeUndefined();
  });

  it('resolves a dollar price to each network default stablecoin', async () => {
    expect(await new ExactEvmScheme().parsePrice('$0.01', BASE)).toEqual({
      amount: '10000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      extra: { name: 'USD Coin', version: '2' },
    });
    expect(await new ExactSvmScheme().parsePrice('$0.01', SOLANA_DEVNET)).toMatchObject({
      amount: '10000',
      asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    });
    expect(await new ExactTvmScheme().parsePrice('$0.01', TON_TESTNET)).toMatchObject({
      amount: '10000',
      asset: '0:f418a04cf196ebc959366844a6cdf53a6fd6fff1eadafc892f05210bba31593e',
    });
  });

  // Config load cannot import the SDK, so the profiles repeat its default assets
  it.each(BUILT_IN_NETWORKS.map((n) => [n.id, n] as const))(
    '%s defaults to the asset the SDK names',
    (_id, network) => {
      const id = network.id as `${string}:${string}`;
      if (network.family === 'evm') {
        const { asset, name, version, decimals, symbol } = evmDefaultAsset(id);
        expect(network.canonicalAsset).toEqual({ symbol, address: asset, name, version, decimals });
        return;
      }
      const sdk = network.family === 'svm' ? svmDefaultAsset(id) : tvmDefaultAsset(id);
      expect(network.canonicalAsset).toEqual({
        symbol: sdk.symbol,
        address: sdk.asset,
        decimals: sdk.decimals,
      });
    },
  );

  it('truncates excess precision to zero, so config load must refuse it first', async () => {
    const parsed = await new ExactEvmScheme().parsePrice('$0.0000001', BASE);
    expect(parsed.amount).toBe('0');
  });
});
