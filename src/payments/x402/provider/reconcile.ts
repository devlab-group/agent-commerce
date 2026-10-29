// Reconcile: read-only chain evidence for an attempt, from its verified locator
import type { PublicClient } from 'viem';
import type { PaymentReconciliationContext, PaymentReconciliationResult } from '../../../core';
import { redactedErrorText } from '../../../core/errors';
import { createLocalPublicClient } from '../chain';
import { LOCATOR_VERSION } from '../locator';
import { parseEvmLocator, readEvmEvidence, unknown } from '../reconcile/evm';
import type { EvmOffer, ProviderContext } from './types';

// Log searches take longer than a health probe
const RECONCILE_TIMEOUT_MS = 30_000;

/**
 * Builds the provider's `reconcile`, which reads the configured offer's RPC.
 * It does not call the facilitator, sign transactions or broadcast them.
 */
export function createReconcile(
  ctx: ProviderContext,
): (context: PaymentReconciliationContext) => Promise<PaymentReconciliationResult> {
  const clients = new Map<EvmOffer, PublicClient>();

  return async ({ attempt, locator }) => {
    if (locator === undefined) return unknown('no_locator');
    if (locator['v'] !== LOCATOR_VERSION) return unknown('unsupported_locator_version');
    const network = locator['network'];
    if (typeof network !== 'string' || !network.startsWith('eip155:')) {
      return unknown('unsupported_family');
    }
    const parsed = parseEvmLocator(locator);
    if (parsed === undefined) return unknown('invalid_locator');
    const offer = ctx.offers.find(
      (candidate): candidate is EvmOffer =>
        candidate.family === 'evm' && candidate.network === network,
    );
    if (offer === undefined) return unknown('network_not_configured', { network });

    let client = clients.get(offer);
    if (client === undefined) {
      client = createLocalPublicClient(offer.rpcUrl, RECONCILE_TIMEOUT_MS, offer.profile.chainId);
      clients.set(offer, client);
    }
    try {
      return await readEvmEvidence({
        client,
        chainId: offer.profile.chainId,
        locator: parsed,
        attempt,
      });
    } catch (err) {
      return unknown('rpc_error', { rpc: offer.rpcOrigin, error: redactedErrorText(err) });
    }
  };
}
