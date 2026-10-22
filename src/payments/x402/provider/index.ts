/**
 * x402 payment provider: protocol v2, `exact` scheme. On EVM the buyer signs an
 * EIP-3009 `transferWithAuthorization` or a Permit2 transfer through the x402
 * exact proxy; on Solana, a token transfer whose fee the facilitator pays; on
 * NEAR, a delegated NEP-141 `ft_transfer` that the facilitator's relayer
 * submits.
 *
 * `verify()` never moves funds. `settle()` does, and throws unless it is handed
 * a successful verification. Both run through a facilitator (see
 * `../facilitator.ts`): the SDK's own `x402Facilitator` in this process, or a
 * remote HTTP facilitator.
 */
import type { AdapterDescriptor } from '../../../core';
import { CommerceError, NOOP_LOGGER, systemClock } from '../../../core';
import { PACKAGE_VERSION } from '../../../version';
import { DEFAULT_IDS, DEFAULT_MAX_TIMEOUT_SECONDS, X402_VERSION } from './constants';
import { createSvmFeePayerSource } from './fee-payer';
import { createHealthCheck } from './health';
import { resolveOffers } from './offers';
import { createQuoteIssuer, QUOTE_EXTENSION, QUOTE_REQUEST_SCHEME } from './quote';
import { createRequirementBuilders } from './requirement';
import { createSettle } from './settle';
import type {
  EvmOffer,
  ProviderContext,
  X402MultiOfferProviderOptions,
  X402OfferOptions,
  X402PaymentProvider,
  X402ProviderOptions,
} from './types';
import { createVerify } from './verify';

export { DEFAULT_IDS } from './constants';
export type {
  X402MultiOfferProviderOptions,
  X402OfferOptions,
  X402PaymentProvider,
  X402ProviderOptions,
} from './types';

export function createX402PaymentProvider(
  options: X402ProviderOptions | X402MultiOfferProviderOptions,
): X402PaymentProvider {
  const inputs: readonly X402OfferOptions[] = 'offers' in options ? options.offers : [options];
  if (inputs.length === 0) {
    throw new CommerceError('CONFIG_INVALID', 'x402 provider: "offers" is empty');
  }
  // The NEAR facilitator refuses every payment under any other value
  if (
    options.maxTimeoutSeconds !== undefined &&
    (!Number.isInteger(options.maxTimeoutSeconds) || options.maxTimeoutSeconds <= 0)
  ) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `x402 provider: maxTimeoutSeconds must be a positive integer (got ${options.maxTimeoutSeconds})`,
    );
  }
  const {
    offers: defaultOffers,
    resourceOffers,
    pool: offers,
    deploymentMode,
    remoteBinding,
  } = resolveOffers(inputs, options);
  const offersFor = (resourceId: string) => resourceOffers.get(resourceId) ?? defaultOffers;
  const severalOffers = [defaultOffers, ...resourceOffers.values()].some((list) => list.length > 1);

  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? DEFAULT_IDS;
  const logger = options.logger ?? NOOP_LOGGER;
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;

  const quotes = options.quote
    ? createQuoteIssuer({
        signerPrivateKey: options.quote.signerPrivateKey,
        offers,
        deploymentMode,
        clock,
        maxTimeoutSeconds,
      })
    : undefined;

  const evmOffers = offers.filter((offer): offer is EvmOffer => offer.family === 'evm');
  const hasSvm = offers.some((offer) => offer.family === 'svm');
  const hasNear = offers.some((offer) => offer.family === 'near');
  const descriptor: AdapterDescriptor = {
    name: 'x402',
    kind: 'payment',
    implementationVersion: PACKAGE_VERSION,
    supportedSpec: `x402/v${X402_VERSION} scheme=exact family=${[
      ...(evmOffers.length > 0 ? ['eip155'] : []),
      ...(hasSvm ? ['solana'] : []),
      ...(hasNear ? ['near'] : []),
    ].join(',')}`,
    capabilities: [
      ...(evmOffers.length > 0 ? ['exact-evm'] : []),
      ...(hasSvm ? ['exact-svm'] : []),
      ...(hasNear ? ['exact-near'] : []),
      `${options.facilitator.mode}-facilitator`,
      ...(evmOffers.some((offer) => offer.method === 'eip3009') ? ['eip-3009'] : []),
      ...(evmOffers.some((offer) => offer.method === 'permit2') ? ['permit2'] : []),
      'caip-2',
      `mode=${deploymentMode}`,
      'authorization-flow',
      'upfront-flow',
      ...(severalOffers ? ['multiple-offers'] : []),
      ...(quotes ? ['erc-8409-quotes'] : []),
    ],
    status: 'stable',
    unsupported: [
      'permit2 gas sponsoring extensions',
      'upto scheme',
      'batch-settlement scheme',
      'auth-capture scheme',
    ],
  };

  // Loaded only with an offer of their family, so no deployment needs the
  // peers of a family it does not offer
  const svmModule = hasSvm
    ? loadOptionalModule(() => import('../svm'), 'Solana offers need @x402/svm and @solana/kit')
    : undefined;
  const nearModule = hasNear
    ? loadOptionalModule(() => import('../near'), 'NEAR offers need @x402/near')
    : undefined;
  const svm = async () => {
    if (!svmModule)
      throw new CommerceError('INTERNAL_ERROR', 'x402 provider: no Solana offer is configured');
    return svmModule;
  };
  const near = async () => {
    if (!nearModule)
      throw new CommerceError('INTERNAL_ERROR', 'x402 provider: no NEAR offer is configured');
    return nearModule;
  };

  const ctx: ProviderContext = {
    options,
    offers,
    offersFor,
    deploymentMode,
    remoteBinding,
    clock,
    ids,
    logger,
    maxTimeoutSeconds,
    quotes,
    svm,
    near,
  };
  const { createRequirement, selectRequirement } = createRequirementBuilders(
    ctx,
    createSvmFeePayerSource(ctx),
  );
  const verify = createVerify(ctx);
  const settle = createSettle(ctx);
  const health = createHealthCheck(ctx);

  return {
    name: 'x402',
    descriptor,
    createRequirement,
    // A single offer needs no selection
    ...(severalOffers ? { selectRequirement } : {}),
    verify,
    settle,
    health,
    ...(quotes
      ? {
          quote: {
            issuer: quotes.issuer,
            requestScheme: QUOTE_REQUEST_SCHEME,
            extension: QUOTE_EXTENSION,
          },
        }
      : {}),
  };
}

/**
 * Loads a family's inspection module, refusing with a clear error when its
 * optional peers are missing
 */
function loadOptionalModule<T>(load: () => Promise<T>, missing: string): Promise<T> {
  const loading = load().catch((cause: unknown) => {
    throw new CommerceError('PAYMENT_PROVIDER_UNAVAILABLE', `x402 provider: ${missing}`, {
      cause,
    });
  });
  // verify() and health() report the failure; nothing else awaits it
  loading.catch(() => {});
  return loading;
}
