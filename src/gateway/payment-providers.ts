/**
 * Builds enabled payment rails on demand. x402 needs no `mppx`; MPP uses
 * x402 internally and needs its EVM peers. Peer loading follows each rail's
 * `enabled` flag, not resource prices: an enabled rail needs its peers even
 * when every resource is free.
 */
import type { GatewayConfig } from '../config';
import type { X402OptionConfig } from '../config/schema';
import type { Logger, PaymentProvider } from '../core';
import type { X402OfferOptions } from '../payments/x402';
import { importOptionalPeer } from './optional-peer';

function offerOptions(option: X402OptionConfig): X402OfferOptions {
  return {
    network: option.network,
    rpcUrl: option.rpcUrl,
    asset: option.asset,
    assetDecimals: option.assetDecimals,
    payTo: option.payTo,
    ...(option.assetName !== undefined ? { assetName: option.assetName } : {}),
    ...(option.assetVersion !== undefined ? { assetVersion: option.assetVersion } : {}),
    ...(option.assetTransferMethod !== undefined
      ? { assetTransferMethod: option.assetTransferMethod }
      : {}),
  };
}

export async function createConfiguredPaymentProviders(
  payments: GatewayConfig['payments'],
  logger: Logger,
): Promise<PaymentProvider[]> {
  const providers: PaymentProvider[] = [];
  const { x402, mpp } = payments;
  if (x402?.enabled) {
    const { createX402PaymentProvider } = await importOptionalPeer(
      'payments.x402',
      () => import('../payments/x402'),
    );
    providers.push(
      createX402PaymentProvider({
        // Support manually built single-option configs without `options`
        offers: (x402.options ?? [x402]).map(offerOptions),
        ...(x402.resourceOptions !== undefined
          ? {
              resourceOffers: Object.fromEntries(
                Object.entries(x402.resourceOptions).map(([id, list]) => [
                  id,
                  list.map(offerOptions),
                ]),
              ),
            }
          : {}),
        maxTimeoutSeconds: x402.maxTimeoutSeconds,
        ...(x402.paymentFlow !== undefined ? { paymentFlow: x402.paymentFlow } : {}),
        ...(x402.resourcePaymentFlows !== undefined
          ? { resourcePaymentFlows: x402.resourcePaymentFlows }
          : {}),
        ...(x402.resourceMimeTypes !== undefined
          ? { resourceMimeTypes: x402.resourceMimeTypes }
          : {}),
        facilitator: x402.facilitator,
        ...(x402.allowMainnet !== undefined ? { allowMainnet: x402.allowMainnet } : {}),
        ...(x402.allowUnauthenticatedFacilitator !== undefined
          ? { allowUnauthenticatedFacilitator: x402.allowUnauthenticatedFacilitator }
          : {}),
        ...(x402.networks !== undefined ? { customNetworks: x402.networks } : {}),
        logger,
      }),
    );
  }
  if (mpp?.enabled) {
    const { createMppPaymentProvider } = await importOptionalPeer(
      'payments.mpp',
      () => import('../payments/mpp/provider'),
    );
    providers.push(
      createMppPaymentProvider({
        recipient: mpp.recipient as `0x${string}`,
        asset: mpp.asset as `0x${string}`,
        assetName: mpp.assetName,
        assetVersion: mpp.assetVersion,
        network: mpp.network,
        realm: mpp.realm,
        challengeSecret: mpp.challengeSecret,
        ...(mpp.challengeTtlSeconds !== undefined
          ? { challengeTtlSeconds: mpp.challengeTtlSeconds }
          : {}),
        rpcUrl: mpp.rpcUrl,
        facilitator: mpp.facilitator,
        ...(mpp.allowMainnet !== undefined ? { allowMainnet: mpp.allowMainnet } : {}),
        ...(mpp.allowUnauthenticatedFacilitator !== undefined
          ? { allowUnauthenticatedFacilitator: mpp.allowUnauthenticatedFacilitator }
          : {}),
        ...(mpp.paymentFlow !== undefined ? { paymentFlow: mpp.paymentFlow } : {}),
        ...(mpp.resourcePaymentFlows !== undefined
          ? { resourcePaymentFlows: mpp.resourcePaymentFlows }
          : {}),
        logger,
      }),
    );
  }
  return providers;
}
