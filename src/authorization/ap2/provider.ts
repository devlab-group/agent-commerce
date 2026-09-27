/**
 * The AP2 authorization provider: the seam between core's generic contract and
 * the mandate machinery.
 *
 * It owns its replay store, so whoever creates it must call `close()`:
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
} from '../../core';
import { NOOP_LOGGER, systemClock } from '../../core';
import { PACKAGE_VERSION } from '../../version';
import { AP2_CHECKOUT_PROFILE, AP2_SPEC_VERSION } from './constants';
import { buildAp2Descriptor } from './descriptor';
import { type Ap2ErrorContext, ap2Replayed, ap2Unavailable } from './errors';
import { bindMandateToPurchase } from './profile';
import { type Ap2ReplayStore, createAp2ReplayStore } from './replay-store';
import type { EnabledAp2Config } from './types';
import { createAp2MandateVerifier } from './verifier';

export interface Ap2AuthorizationProviderOptions {
  readonly config: EnabledAp2Config;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** Injectable so tests need not touch the filesystem */
  readonly replayStore?: Ap2ReplayStore;
}

export interface Ap2AuthorizationProvider extends AuthorizationProvider {
  /** Closes the replay store */
  close(): void;
}

export function createAp2AuthorizationProvider(
  options: Ap2AuthorizationProviderOptions,
): Ap2AuthorizationProvider {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? NOOP_LOGGER;

  const verifier = createAp2MandateVerifier({ config: options.config, clock });
  const replay =
    options.replayStore ?? createAp2ReplayStore({ path: options.config.replay.path, logger });

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

    let reservation: ReturnType<Ap2ReplayStore['reserve']>;
    try {
      reservation = replay.reserve({
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

  const finalize = (
    action: 'consume' | 'release' | 'markUncertain',
    reservationId: string,
    context: AuthorizationFinalizeContext,
  ): void => {
    try {
      replay[action](reservationId);
    } catch (cause) {
      throw ap2Unavailable(`replay store could not record ${action}`, { ...context, cause });
    }
  };

  return {
    name: 'ap2',
    descriptor: buildAp2Descriptor(PACKAGE_VERSION),
    requirement,
    verifyAndReserve,

    async consume(reservationId, context) {
      finalize('consume', reservationId, context);
    },
    async release(reservationId, context) {
      finalize('release', reservationId, context);
    },
    async markUncertain(reservationId, context) {
      finalize('markUncertain', reservationId, context);
    },

    async health(): Promise<AdapterHealth> {
      const startedAt = clock.monotonicMs();
      const checkedAt = clock.nowIso();
      let available = true;
      try {
        // A read against the real table, so a database that opened but cannot
        // be queried is caught here rather than on the first purchase
        replay.stateOf('health-probe');
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
      replay.close();
    },
  };
}
