/**
 * Builds providers for the enabled payment rails. This composition-root module
 * statically imports both rail implementations and their static peer
 * dependencies, so the peer-free main entry and CLI must not import it.
 */
import type { GatewayConfig } from '../config/index.js';
import type { Logger, PaymentProvider } from '../core/index.js';
import { MPP_PROFILE } from '../payments/mpp/constants.js';
import { createMppPaymentProvider } from '../payments/mpp/provider.js';
import { createX402PaymentProvider } from '../payments/x402/index.js';

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
    const asset = mpp.asset as `0x${string}`;
    const recipient = mpp.recipient as `0x${string}`;
    providers.push(
      createMppPaymentProvider({
        recipient,
        asset,
        assetName: mpp.assetName,
        assetVersion: mpp.assetVersion,
        network: mpp.network,
        realm: mpp.realm,
        challengeSecret: mpp.challengeSecret,
        ...(mpp.challengeTtlSeconds !== undefined
          ? { challengeTtlSeconds: mpp.challengeTtlSeconds }
          : {}),
        // Built from the MPP block alone and never registered as a rail, so an
        // MPP-only deployment needs no `payments.x402`
        settlement: createX402PaymentProvider({
          network: mpp.network,
          rpcUrl: mpp.rpcUrl,
          asset,
          assetName: mpp.assetName,
          assetVersion: mpp.assetVersion,
          assetDecimals: MPP_PROFILE.assetDecimals,
          payTo: recipient,
          facilitator: mpp.facilitator,
          ...(mpp.allowMainnet !== undefined ? { allowMainnet: mpp.allowMainnet } : {}),
          ...(mpp.allowUnauthenticatedFacilitator !== undefined
            ? { allowUnauthenticatedFacilitator: mpp.allowUnauthenticatedFacilitator }
            : {}),
          logger,
        }),
      }),
    );
  }
  return providers;
}
