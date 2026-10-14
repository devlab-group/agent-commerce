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
  decodeSignedDelegateB64,
  getDefaultAsset as nearDefaultAsset,
  parseFtTransferArgs,
} from '@x402/near';
import { ExactNearScheme } from '@x402/near/exact/server';
import {
  decodeTransactionFromPayload,
  getDefaultAsset as svmDefaultAsset,
  transactionMessageHash,
} from '@x402/svm';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_NETWORKS } from '../../../src/payments/x402/networks';

const BASE = 'eip155:8453';
const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const NEAR_TESTNET = 'near:testnet';

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

  it('exports what the Solana and NEAR replay identities read', () => {
    expect(typeof decodeTransactionFromPayload).toBe('function');
    expect(typeof transactionMessageHash).toBe('function');
    expect(typeof decodeSignedDelegateB64).toBe('function');
    expect(
      parseFtTransferArgs(new TextEncoder().encode('{"receiver_id":"m.near","amount":"1"}')),
    ).toEqual({
      receiver_id: 'm.near',
      amount: '1',
    });
  });

  it('adds nothing to a NEAR offer: the facilitator picks its relayer', async () => {
    const offer = {
      scheme: 'exact',
      network: NEAR_TESTNET,
      asset: 'usdc.testnet',
      amount: '1',
      payTo: 'm.testnet',
      maxTimeoutSeconds: 60,
      extra: {},
    } as const;
    const kind = { x402Version: 2, scheme: 'exact', network: NEAR_TESTNET } as const;
    expect(
      await new ExactNearScheme().enhancePaymentRequirements(offer as never, kind as never, []),
    ).toEqual(offer);
  });

  it('marks only the Solana blockhash hints as dynamic for offer matching', () => {
    // Read as the resource server reads them, through the scheme interface
    const dynamic = (scheme: SchemeNetworkServer) => scheme.dynamicExtraFields;
    expect(dynamic(new ExactSvmScheme())).toEqual(['recentBlockhash', 'lastValidBlockHeight']);
    expect(dynamic(new ExactEvmScheme())).toBeUndefined();
    expect(dynamic(new ExactNearScheme())).toBeUndefined();
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
    expect(await new ExactNearScheme().parsePrice('$0.01', NEAR_TESTNET)).toMatchObject({
      amount: '10000',
      asset: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
    });
  });

  // Config load cannot import the SDK, so the profiles repeat its default assets
  // The local Anvil chain has no default asset and is skipped; Nano has no SDK
  const sdkNetworks = BUILT_IN_NETWORKS.filter((n) => n.canonicalAsset && n.family !== 'nano');
  it.each(sdkNetworks.map((n) => [n.id, n] as const))(
    '%s defaults to the asset the SDK names',
    (_id, network) => {
      const id = network.id as `${string}:${string}`;
      if (network.family === 'evm') {
        const sdk = evmDefaultAsset(id);
        const { asset, name, version, decimals, symbol } = sdk;
        expect(network.canonicalAsset).toEqual({ symbol, address: asset, name, version, decimals });
        // A default asset settles through EIP-3009, the method an option without one gets
        expect(sdk.assetTransferMethod ?? 'eip3009').toBe('eip3009');
        return;
      }
      const sdk = network.family === 'svm' ? svmDefaultAsset(id) : nearDefaultAsset(id);
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
