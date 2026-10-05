/**
 * Builds providers for the enabled payment rails. This composition-root module
 * statically imports both rail implementations and their static peer
 * dependencies, so the peer-free main entry and CLI must not import it.
 */
import type { GatewayConfig } from '../config';
import type { Logger, PaymentProvider } from '../core';
import { createMppPaymentProvider } from '../payments/mpp/provider';
import { createX402PaymentProvider } from '../payments/x402';

export function createConfiguredPaymentProviders(
  payments: GatewayConfig['payments'],
  logger: Logger,
): PaymentProvider[] {
  const providers: PaymentProvider[] = [];
  const { x402, mpp } = payments;
  if (x402?.enabled) {
    providers.push(
      createX402PaymentProvider({
        network: x402.network,
        rpcUrl: x402.rpcUrl,
        asset: x402.asset as `0x${string}`,
        assetName: x402.assetName,
        assetVersion: x402.assetVersion,
        assetDecimals: x402.assetDecimals,
        payTo: x402.payTo as `0x${string}`,
        maxTimeoutSeconds: x402.maxTimeoutSeconds,
        ...(x402.paymentFlow !== undefined ? { paymentFlow: x402.paymentFlow } : {}),
        ...(x402.resourcePaymentFlows !== undefined
          ? { resourcePaymentFlows: x402.resourcePaymentFlows }
          : {}),
        facilitator: x402.facilitator,
        ...(x402.allowMainnet !== undefined ? { allowMainnet: x402.allowMainnet } : {}),
        ...(x402.allowUnauthenticatedFacilitator !== undefined
          ? { allowUnauthenticatedFacilitator: x402.allowUnauthenticatedFacilitator }
          : {}),
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
