// Forward Bazaar metadata to supporting facilitators and log cataloging outcomes
import type { PaymentRequired } from '@x402/core/types';
import { redactedErrorText } from '../../../core/errors';
import { isRecord } from '../../../core/is-record';
import { BAZAAR_EXTENSION_KEY } from './bazaar';
import type { SupportedSource } from './fee-payer';
import type { ProviderContext } from './types';

// Maximum wait for `/supported` before forwarding a proof without metadata
const SUPPORTED_GRACE_MS = 1_000;
// Bound the amount of facilitator-controlled reason text written to the log
const MAX_LOGGED_REASON_LENGTH = 200;

export interface BazaarForwarding {
  /**
   * Return `issued` when it carries Bazaar metadata and the remote facilitator
   * lists `bazaar` in `/supported`. Otherwise return `undefined`, which omits
   * its `resource` and metadata. Failed or slow reads omit them too.
   */
  issuedFor(issued: PaymentRequired | undefined): Promise<PaymentRequired | undefined>;
  /** Log a cataloging refusal from a verify or settle result, once per resource */
  report(resourceId: string, extensionResponses: Record<string, unknown> | undefined): void;
}

/**
 * Forward metadata only to remote facilitators that list `bazaar` in
 * `/supported`, as specified in x402 v2 section 7.3. Unsupported fields could
 * otherwise cause a facilitator to reject the buyer's payment. The in-process
 * facilitator keeps no catalog and receives no metadata. Wait up to one second
 * for `/supported`, then proceed without metadata if the read is slow or fails.
 */
export function createBazaarForwarding(
  ctx: ProviderContext,
  currentSupported: SupportedSource,
): BazaarForwarding {
  const { remoteBinding, logger } = ctx;
  let unlistedLogged = false;
  const rejectedLogged = new Set<string>();

  async function listed(): Promise<boolean> {
    if (remoteBinding?.kind !== 'remote') return false;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), SUPPORTED_GRACE_MS);
      timer.unref();
    });
    const supported = await Promise.race([currentSupported(), late])
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
    if (supported === undefined) return false;
    const lists =
      Array.isArray(supported.extensions) && supported.extensions.includes(BAZAAR_EXTENSION_KEY);
    if (!lists && !unlistedLogged) {
      unlistedLogged = true;
      logger.warn(
        { facilitator: remoteBinding.describe },
        'x402: the facilitator does not list the bazaar extension in /supported; Bazaar metadata stays in challenges but is not sent to it',
      );
    }
    return lists;
  }

  return {
    async issuedFor(issued) {
      if (issued?.extensions?.[BAZAAR_EXTENSION_KEY] === undefined) return undefined;
      return (await listed()) ? issued : undefined;
    },
    report(resourceId, extensionResponses) {
      const outcome = extensionResponses?.[BAZAAR_EXTENSION_KEY];
      if (!isRecord(outcome) || outcome['status'] !== 'rejected') return;
      if (rejectedLogged.has(resourceId)) return;
      rejectedLogged.add(resourceId);
      const reason = outcome['rejectedReason'];
      logger.warn(
        {
          resourceId,
          ...(typeof reason === 'string'
            ? { reportedReason: redactedErrorText(reason).slice(0, MAX_LOGGED_REASON_LENGTH) }
            : {}),
        },
        'x402: the facilitator rejected the Bazaar metadata of a resource and will not catalog it. Payment is unaffected',
      );
    },
  };
}
