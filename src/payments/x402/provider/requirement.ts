// The challenge a resource answers with, and the offer a proof selects from it
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import type { PaymentContext, PaymentRequirement, PaymentVerificationContext } from '../../../core';
import { CommerceError } from '../../../core';
import {
  REUSE_REJECTED_AUTHORIZATION_METADATA_KEY,
  SETTLE_AFTER_BACKEND_METADATA_KEY,
} from '../../../core/execution/settlement-order';
import { sameAddress } from '../addresses';
import { parseCanonicalAmount } from '../amount';
import type { X402Network } from '../networks';
import { decodePaymentSubmission } from '../payload';
import { X402_DEFAULT_PAYMENT_FLOW } from '../payment-flow';
import { DEFAULT_MIME_TYPE, X402_PROTOCOL_VERSION, X402_VERSION } from './constants';
import type { ProviderContext, SvmOffer } from './types';

// Requirement metadata naming the offer `selectRequirement` chose, by index
export const SELECTED_OFFER_KEY = 'x402.offer';

// Use the selected or sole offer; multi-offer challenges require selection
export function offerIndexOf(requirement: PaymentRequirement): number | undefined {
  const selected = requirement.metadata?.[SELECTED_OFFER_KEY];
  if (typeof selected === 'number') return selected;
  // An empty list falls through to 'missing_payment_requirements'
  return requirement.challenge.accepts.length <= 1 ? 0 : undefined;
}

/**
 * Match echoed terms against the offer. Extra client keys and
 * `maxTimeoutSeconds` do not matter; EVM addresses ignore case, Solana's do
 * not. Compare effective payment flows so an upfront proof cannot pay a default
 * authorization offer.
 */
export function acceptedMatchesOffer(
  offered: PaymentRequirements,
  accepted: PaymentRequirements,
  network: X402Network | undefined,
): boolean {
  if (!network) return false;
  const same = (a: string, b: string) => sameAddress(network, a, b);
  const offeredExtra = offered.extra ?? {};
  const acceptedExtra = accepted.extra ?? {};
  const flow = (extra: Record<string, unknown>) =>
    extra['paymentFlow'] ?? X402_DEFAULT_PAYMENT_FLOW;
  return (
    accepted.scheme === offered.scheme &&
    accepted.network === offered.network &&
    accepted.amount === offered.amount &&
    same(accepted.asset, offered.asset) &&
    same(accepted.payTo, offered.payTo) &&
    Object.entries(offeredExtra).every(([key, value]) => acceptedExtra[key] === value) &&
    flow(acceptedExtra) === flow(offeredExtra)
  );
}

/** Builds the provider's `createRequirement` and `selectRequirement` */
export function createRequirementBuilders(
  ctx: ProviderContext,
  svmFeePayer: (offer: SvmOffer) => Promise<string>,
): {
  readonly createRequirement: (context: PaymentContext) => Promise<PaymentRequirement>;
  readonly selectRequirement: (context: PaymentVerificationContext) => Promise<PaymentRequirement>;
} {
  const { options, offersFor, clock, ids, maxTimeoutSeconds } = ctx;

  async function createRequirement(context: PaymentContext): Promise<PaymentRequirement> {
    const offers = offersFor(context.resource.id);
    // XNO has no USD peg and the gateway holds no rate: a price in any other
    // currency would be charged as that many XNO
    if (context.currency !== 'XNO' && offers.some((offer) => offer.family === 'nano')) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `x402 provider: resource "${context.resource.id}" is priced in ${context.currency}, but a Nano offer charges XNO`,
      );
    }
    const paymentFlow =
      options.resourcePaymentFlows?.[context.resource.id] ??
      options.paymentFlow ??
      X402_DEFAULT_PAYMENT_FLOW;

    // x402 requires an explicit non-default flow. Omit the default
    // `authorization` flow here.
    const flow = paymentFlow === 'upfront' ? { paymentFlow } : {};
    const accepts: PaymentRequirements[] = await Promise.all(
      offers.map(async (offer) => ({
        scheme: 'exact',
        network: offer.network,
        asset: offer.asset,
        amount: parseCanonicalAmount(context.amount, offer.assetDecimals).toString(),
        payTo: offer.payTo,
        maxTimeoutSeconds,
        // EIP-3009 needs `name`/`version` for a shared EIP-712 domain without
        // a token `version()` call; Permit2 uses its own domain. EVM clients
        // sign the named `assetTransferMethod`. Solana needs the facilitator's
        // fee payer; NEAR needs no scheme-specific extra because the
        // facilitator chooses its relayer.
        extra:
          offer.family === 'svm'
            ? { feePayer: await svmFeePayer(offer), ...flow }
            : offer.family === 'near' || offer.family === 'nano'
              ? { ...flow }
              : {
                  ...(offer.assetName !== undefined ? { name: offer.assetName } : {}),
                  ...(offer.assetVersion !== undefined ? { version: offer.assetVersion } : {}),
                  assetTransferMethod: offer.method,
                  ...flow,
                },
      })),
    );
    const single = offers.length === 1 ? offers[0] : undefined;

    // The v2 challenge document as sent on the wire. The HTTP adapter
    // base64-encodes it into `PAYMENT-REQUIRED` and MCP passes it through, so
    // both surfaces offer the same challenge.
    //
    // `resource.url` is outside the EIP-3009 signature. A single offer puts its
    // network and payee in it, so the buyer's echo identifies the offer. With
    // several, the URL stays the same whichever one the buyer pays.
    const resourceId = encodeURIComponent(context.resource.id);
    const envelope: PaymentRequired = {
      x402Version: X402_VERSION,
      resource: {
        url: single
          ? `resource://agent-commerce/${encodeURIComponent(single.network)}/${single.payTo}/resources/${resourceId}`
          : `resource://agent-commerce/resources/${resourceId}`,
        description: context.resource.description ?? context.resource.name,
        // The media type the merchant declares, else `application/json`; an HTTP
        // delivery carries the backend's own type when it is text and fits the body
        mimeType: options.resourceMimeTypes?.[context.resource.id] ?? DEFAULT_MIME_TYPE,
      },
      accepts,
    };

    const expiresAt = new Date(clock.now().getTime() + maxTimeoutSeconds * 1000).toISOString();

    return {
      id: ids.next('payreq'),
      requestId: context.requestId,
      resourceId: context.resource.id,
      provider: 'x402',
      amount: context.amount,
      currency: context.currency,
      // Several offers name several destinations; selection fills these in
      ...(single
        ? { destination: single.payTo, network: single.network, asset: single.asset }
        : {}),
      expiresAt,
      challenge: {
        provider: 'x402',
        version: X402_PROTOCOL_VERSION,
        accepts: accepts as unknown as Record<string, unknown>[],
        envelope: envelope as unknown as Record<string, unknown>,
      },
      metadata: {
        [SETTLE_AFTER_BACKEND_METADATA_KEY]: paymentFlow === 'authorization',
        // The SDK server keeps no record of a payload whose handler or
        // settlement failed and verifies it again; the chain spends it once
        [REUSE_REJECTED_AUTHORIZATION_METADATA_KEY]: true,
      },
    };
  }

  /**
   * Selects the unique offer matching `accepted`, leaving zero or multiple
   * matches unchanged for `verify()` to reject. Selection identifies the
   * claimed offer; verification still validates the proof.
   */
  async function selectRequirement(
    context: PaymentVerificationContext,
  ): Promise<PaymentRequirement> {
    const { requirement, submission } = context;
    const offered = requirement.challenge.accepts as unknown as PaymentRequirements[];
    if (offered.length < 2) return requirement;
    const offers = offersFor(requirement.resourceId);
    const payload = decodePaymentSubmission(submission.payload);
    if (!payload) return requirement;
    const matches = offered.flatMap((offer, index) =>
      acceptedMatchesOffer(offer, payload.accepted, offers[index]?.profile) ? [index] : [],
    );
    const index = matches.length === 1 ? matches[0] : undefined;
    const offer = index === undefined ? undefined : offers[index];
    if (index === undefined || !offer) return requirement;
    return {
      ...requirement,
      destination: offer.payTo,
      network: offer.network,
      asset: offer.asset,
      metadata: { ...requirement.metadata, [SELECTED_OFFER_KEY]: index },
    };
  }

  return { createRequirement, selectRequirement };
}
