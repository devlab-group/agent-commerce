/**
 * Builds providers for the enabled payment rails. This composition-root module
 * statically imports both rail implementations and their static peer
 * dependencies, so the peer-free main entry and CLI must not import it.
 */
import type { GatewayConfig } from '../config';
import type { X402OptionConfig } from '../config/schema';
import type { Logger, PaymentProvider } from '../core';
import { createMppPaymentProvider } from '../payments/mpp/provider';
import { createX402PaymentProvider, type X402OfferOptions } from '../payments/x402';

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

export function createConfiguredPaymentProviders(
  payments: GatewayConfig['payments'],
  logger: Logger,
): PaymentProvider[] {
  const providers: PaymentProvider[] = [];
  const { x402, mpp } = payments;
  if (x402?.enabled) {
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
