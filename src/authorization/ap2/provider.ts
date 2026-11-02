/**
 * The AP2 authorization provider: the seam between core's generic contract and
 * the mandate machinery.
 *
 * Choose the first available backend: `replayStore`, a receipt store with all
 * hold methods, or the deprecated replay file. Creators must call `close()`:
 * it closes the legacy replay backend but leaves the receipt store open.
 * `createGateway` does not close authorization providers.
 */
import type {
  AdapterHealth,
  AuthorizationFinalizeContext,
  AuthorizationProvider,
  AuthorizationRequirement,
  AuthorizationVerification,
  AuthorizationVerificationContext,
  Clock,
  Logger,
  ReceiptStore,
} from '../../core';
import { CommerceError, NOOP_LOGGER, systemClock } from '../../core';
import { hasMethodGroup, type StoreGroupMethods } from '../../core/store-method-groups';
import { PACKAGE_VERSION } from '../../version';
import { AP2_CHECKOUT_PROFILE, AP2_SPEC_VERSION } from './constants';
import { buildAp2Descriptor } from './descriptor';
import { type Ap2ErrorContext, ap2Replayed, ap2Unavailable } from './errors';
import { bindMandateToPurchase } from './profile';
import {
  type Ap2AuthorizationState,
  type Ap2ReplayStore,
  type Ap2ReservationRequest,
  type Ap2ReservationResult,
  createAp2ReplayStore,
} from './replay-store';
import type { EnabledAp2Config } from './types';
import { createAp2MandateVerifier } from './verifier';

export interface Ap2AuthorizationProviderOptions {
  readonly config: EnabledAp2Config;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /**
   * Holds mandates when all authorization-hold methods are present and no
   * `replayStore` is supplied. `close()` leaves this shared store open.
   */
  readonly store?: ReceiptStore;
  /**
   * Takes precedence over `store`, and `close()` closes it.
   * @deprecated Pass `store`; 3.0.0 removes this option.
   */
  readonly replayStore?: Ap2ReplayStore;
}

export interface Ap2AuthorizationProvider extends AuthorizationProvider {
  /** Close the legacy replay store opened or supplied; leave the receipt store open */
  close(): void;
}

type Transition = 'consume' | 'release' | 'markUncertain';

// One interface for both backends. A legacy store's void result counts as
// applied; only an explicit false means the transition was refused.
interface Holds {
  reserve(request: Ap2ReservationRequest): Promise<Ap2ReservationResult>;
  // biome-ignore lint/suspicious/noConfusingVoidType: keeps void-returning stores assignable
  transition(action: Transition, reference: string, requestId: string): Promise<boolean | void>;
  stateOf(reference: string): Promise<Ap2AuthorizationState | undefined>;
  close(): void;
}

const HOLD_STATES = {
  consume: 'consumed',
  release: 'released',
  markUncertain: 'uncertain',
} as const;

function fileHolds(replay: Ap2ReplayStore): Holds {
  return {
    reserve: async (request) => replay.reserve(request),
    transition: async (action, reference, requestId) => replay[action](reference, requestId),
    stateOf: async (reference) => replay.stateOf(reference),
    close: () => replay.close(),
  };
}

function storeHolds(store: StoreGroupMethods<'authorization_holds'>): Holds {
  return {
    reserve: (request) =>
      store.reserveAuthorizationHold({
        method: 'ap2',
        reference: request.reference,
        bindingReference: request.checkoutJti,
        resourceId: request.resourceId,
        requestId: request.requestId,
        metadata: { mandateIssuer: request.mandateIssuer, checkoutIssuer: request.checkoutIssuer },
      }),
    transition: (action, reference, requestId) =>
      store.transitionAuthorizationHold(reference, HOLD_STATES[action], requestId),
    stateOf: (reference) => store.getAuthorizationHoldState(reference),
    close: () => {},
  };
}

function openHolds(options: Ap2AuthorizationProviderOptions, logger: Logger): Holds {
  if (options.replayStore !== undefined) return fileHolds(options.replayStore);
  if (hasMethodGroup(options.store, 'authorization_holds')) return storeHolds(options.store);
  const path = options.config.replay?.path;
  if (path === undefined) {
    throw new CommerceError(
      'CONFIG_INVALID',
      'AP2 needs somewhere to record spent mandates: pass a receipt store with authorization holds, or set authorization.ap2.replay.path',
      { details: { path: 'authorization.ap2.replay.path' } },
    );
  }
  return fileHolds(createAp2ReplayStore({ path, logger }));
}

export function createAp2AuthorizationProvider(
  options: Ap2AuthorizationProviderOptions,
): Ap2AuthorizationProvider {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? NOOP_LOGGER;

  const verifier = createAp2MandateVerifier({ config: options.config, clock });
  const holds = openHolds(options, logger);

  const requirement: AuthorizationRequirement = {
    method: 'ap2',
    version: AP2_SPEC_VERSION,
    profile: AP2_CHECKOUT_PROFILE,
  };

  async function verifyAndReserve(
    context: AuthorizationVerificationContext,
  ): Promise<AuthorizationVerification> {
    const errorContext: Ap2ErrorContext = {
      requestId: context.requestId,
      resourceId: context.resourceId,
    };

    const mandate = await verifier.verify(context.submission.payload, errorContext);
    // Before reserving, not after: a mandate that does not authorize this
    // purchase must stay spendable on the purchase it does authorize
    await bindMandateToPurchase(mandate, context, errorContext);

    let reservation: Ap2ReservationResult;
    try {
      reservation = await holds.reserve({
        reference: mandate.reference,
        checkoutJti: mandate.checkoutJwtId,
        mandateIssuer: mandate.mandateIssuer,
        checkoutIssuer: mandate.checkoutIssuer,
        resourceId: context.resourceId,
        requestId: context.requestId,
      });
    } catch (cause) {
      throw ap2Unavailable('replay store could not be written', { ...errorContext, cause });
    }

    if (reservation.kind === 'replayed') {
      throw ap2Replayed(reservation.state, errorContext);
    }

    return {
      status: 'verified',
      method: 'ap2',
      reference: mandate.reference,
      // The reservation handle is the reference itself, so the two can never
      // name different mandates
      reservationId: mandate.reference,
      // Opaque identifiers an operator can reconcile with. Never a claim from
      // the mandate: those carry the buyer's purchase and their personal data.
      // `checkoutId`, not `checkoutJwtId` - the receipt store redacts any key
      // that reads as secret-shaped, and "jwt" is on that list.
      metadata: {
        mandateIssuer: mandate.mandateIssuer,
        checkoutIssuer: mandate.checkoutIssuer,
        checkoutId: mandate.checkoutJwtId,
      },
    };
  }

  const finalize = async (
    action: Transition,
    reservationId: string,
    context: AuthorizationFinalizeContext,
  ): Promise<void> => {
    let applied: Awaited<ReturnType<Holds['transition']>>;
    try {
      applied = await holds.transition(action, reservationId, context.requestId);
    } catch (cause) {
      throw ap2Unavailable(`replay store could not record ${action}`, { ...context, cause });
    }
    // Reject an explicit false so callers do not record an unconfirmed hold update
    if (applied === false) {
      throw ap2Unavailable(`replay store holds no matching reservation to ${action}`, context);
    }
  };

  return {
    name: 'ap2',
    descriptor: buildAp2Descriptor(PACKAGE_VERSION),
    requirement,
    verifyAndReserve,

    consume: (reservationId, context) => finalize('consume', reservationId, context),
    release: (reservationId, context) => finalize('release', reservationId, context),
    markUncertain: (reservationId, context) => finalize('markUncertain', reservationId, context),

    async health(): Promise<AdapterHealth> {
      const startedAt = clock.monotonicMs();
      const checkedAt = clock.nowIso();
      let available = true;
      try {
        // A read against the real table, so a database that opened but cannot
        // be queried is caught here rather than on the first purchase
        await holds.stateOf('health-probe');
      } catch {
        available = false;
      }
      const durationMs = Math.round(clock.monotonicMs() - startedAt);
      if (!available) {
        // A fixed token, never a sentence built from the caught error
        return { status: 'fail', checkedAt, durationMs, detail: 'replay-store-unavailable' };
      }
      const trusted = verifier.trustedIssuers();
      return {
        status: 'pass',
        checkedAt,
        durationMs,
        detail: `mandate-issuers=${trusted.mandate.length} checkout-issuers=${trusted.checkout.length}`,
      };
    },

    close() {
      holds.close();
    },
  };
}
