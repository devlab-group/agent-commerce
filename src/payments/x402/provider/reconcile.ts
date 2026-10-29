// Reconcile: read-only chain evidence for an attempt, from its verified locator
import type { PublicClient } from 'viem';
import type { PaymentReconciliationContext, PaymentReconciliationResult } from '../../../core';
import { redactedErrorText } from '../../../core/errors';
import { createLocalPublicClient } from '../chain';
import { jsonRpc } from '../json-rpc';
import { LOCATOR_VERSION } from '../locator';
import { parseEvmLocator, readEvmEvidence, unknown } from '../reconcile/evm';
import { parseNearLocator, readNearEvidence } from '../reconcile/near';
import { parseSvmLocator, readSvmEvidence } from '../reconcile/svm';
import type { EvmOffer, Offer, ProviderContext } from './types';

// Allow more RPC time for log and history searches than for health probes
const RECONCILE_TIMEOUT_MS = 30_000;

/**
 * Builds the provider's `reconcile`, which reads the configured offer's RPC.
 * It does not call the facilitator, sign transactions or broadcast them.
 */
export function createReconcile(
  ctx: ProviderContext,
): (context: PaymentReconciliationContext) => Promise<PaymentReconciliationResult> {
  const clients = new Map<EvmOffer, PublicClient>();
  const evmClient = (offer: EvmOffer) => {
    let client = clients.get(offer);
    if (client === undefined) {
      client = createLocalPublicClient(offer.rpcUrl, RECONCILE_TIMEOUT_MS, offer.profile.chainId);
      clients.set(offer, client);
    }
    return client;
  };
  const rpc = (offer: Offer) => (method: string, params: unknown) =>
    jsonRpc(offer.rpcUrl, method, params, RECONCILE_TIMEOUT_MS);
  const read = async (offer: Offer, evidence: () => Promise<PaymentReconciliationResult>) => {
    try {
      return await evidence();
    } catch (err) {
      return unknown('rpc_error', { rpc: offer.rpcOrigin, error: redactedErrorText(err) });
    }
  };

  return async ({ attempt, locator }) => {
    if (locator === undefined) return unknown('no_locator');
    if (locator['v'] !== LOCATOR_VERSION) return unknown('unsupported_locator_version');
    const network = locator['network'];
    if (typeof network !== 'string') return unknown('unsupported_family');
    const offerFor = <F extends Offer['family']>(family: F) =>
      ctx.offers.find(
        (candidate): candidate is Extract<Offer, { family: F }> =>
          candidate.family === family && candidate.network === network,
      );
    const notConfigured = unknown('network_not_configured', { network });

    if (network.startsWith('eip155:')) {
      const parsed = parseEvmLocator(locator);
      if (parsed === undefined) return unknown('invalid_locator');
      const offer = offerFor('evm');
      if (offer === undefined) return notConfigured;
      return read(offer, () =>
        readEvmEvidence({
          client: evmClient(offer),
          chainId: offer.profile.chainId,
          locator: parsed,
          attempt,
        }),
      );
    }
    if (network.startsWith('solana:')) {
      const parsed = parseSvmLocator(locator);
      if (parsed === undefined) return unknown('invalid_locator');
      const offer = offerFor('svm');
      if (offer === undefined) return notConfigured;
      const { messageHashOf } = await ctx.svm();
      return read(offer, () =>
        readSvmEvidence({ rpc: rpc(offer), network, locator: parsed, attempt, messageHashOf }),
      );
    }
    if (network.startsWith('near:')) {
      const parsed = parseNearLocator(locator);
      if (parsed === undefined) return unknown('invalid_locator');
      const offer = offerFor('near');
      if (offer === undefined) return notConfigured;
      return read(offer, () =>
        readNearEvidence({ rpc: rpc(offer), network, locator: parsed, attempt }),
      );
    }
    return unknown('unsupported_family');
  };
}
