// What the pipeline's stages share: its options, and event and persistence writes that never fail a flow
import type { AuthorizationProvider, AuthorizationRecord } from '../../domain/authorization';
import type { CommerceEvent, EventSink } from '../../domain/event';
import type {
  PaymentProvider,
  PaymentRequirement,
  PaymentResult,
  PaymentSubmission,
} from '../../domain/payment';
import type { CanonicalRequest } from '../../domain/request';
import type { CommerceResource, ResourceRegistry } from '../../domain/resource';
import type { AuthorizationHoldState, PersistenceFailure } from '../../domain/transaction';
import { describeError } from '../../errors';
import type { BackendExecutor } from '../../interfaces/backend';
import type { Logger } from '../../interfaces/logger';
import type { Clock, IdGenerator } from '../../interfaces/runtime';
import type { ReceiptStore, TransactionStep } from '../../interfaces/store';
import type { Flow } from '../journal';

export interface CreateExecutionPipelineOptions {
  readonly resources: ResourceRegistry;
  readonly paymentProviders: readonly PaymentProvider[];
  /** Defaults to none */
  readonly authorizationProviders?: readonly AuthorizationProvider[];
  readonly store: ReceiptStore;
  readonly backend: BackendExecutor;
  readonly events: EventSink;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export type HoldAction = 'consume' | 'release' | 'markUncertain';

/**
 * An authorization reservation and its receipt summary. `finalize` returns
 * false on provider errors; journal state changes only after it returns true.
 */
export interface AuthorizationHold {
  readonly record: AuthorizationRecord;
  /** Handle used to consume, release or mark the reservation uncertain */
  readonly reservationId: string;
  finalize(action: HoldAction): Promise<boolean>;
}

/** Journal step data before the pipeline adds its transaction ID and timestamp */
export type StepBody = TransactionStep extends infer S
  ? S extends TransactionStep
    ? Omit<S, 'transactionId' | 'at'>
    : never
  : never;

const HOLD_STATES: Readonly<Record<HoldAction, AuthorizationHoldState>> = {
  consume: 'consumed',
  release: 'released',
  markUncertain: 'uncertain',
};

/** A verified, reserved payment and everything its settlement needs */
export interface SettleArgs {
  readonly flow: Flow;
  readonly request: CanonicalRequest;
  readonly resource: CommerceResource;
  readonly provider: PaymentProvider;
  readonly requirement: PaymentRequirement;
  readonly payment: PaymentSubmission;
  readonly verification: PaymentResult;
  readonly replayKey: string;
  readonly hold: AuthorizationHold | undefined;
}

export interface PipelineContext {
  readonly options: CreateExecutionPipelineOptions;
  /** Emits an event; a failing sink is logged, never thrown */
  readonly safeEmit: (event: CommerceEvent) => Promise<void>;
  /**
   * Run a store write, returning true on success and false on failure.
   * Write errors are logged at error level; a supplied `failure` label is
   * recorded once in `flow.persistenceFailures`.
   */
  readonly safePersist: (
    flow: Flow,
    op: () => Promise<void>,
    label: string,
    failure?: PersistenceFailure,
  ) => Promise<boolean>;
  /** Record a journal step when enabled, logging store errors instead of aborting */
  readonly recordStep: (flow: Flow, step: StepBody) => Promise<void>;
  /** Apply a hold action and attempt its journal step only after provider success */
  readonly finalizeHold: (
    flow: Flow,
    hold: AuthorizationHold | undefined,
    action: HoldAction,
  ) => Promise<void>;
  readonly buildEvent: (
    flow: Flow,
    partial: Omit<CommerceEvent, 'id' | 'at' | 'requestId' | 'transactionId'>,
  ) => CommerceEvent;
}

export function createPipelineContext(options: CreateExecutionPipelineOptions): PipelineContext {
  async function safeEmit(event: CommerceEvent): Promise<void> {
    try {
      await options.events.emit(event);
    } catch (error) {
      options.logger.error(
        { err: describeError(error), eventType: event.type, requestId: event.requestId },
        'Event sink failed; commerce flow continues',
      );
    }
  }

  async function safePersist(
    flow: Flow,
    op: () => Promise<void>,
    label: string,
    failure?: PersistenceFailure,
  ): Promise<boolean> {
    try {
      await op();
      return true;
    } catch (error) {
      options.logger.error(
        {
          err: describeError(error),
          requestId: flow.request.requestId,
          transactionId: flow.transactionId,
        },
        `Persistence failed: ${label}`,
      );
      if (failure !== undefined && !flow.persistenceFailures.includes(failure)) {
        flow.persistenceFailures.push(failure);
      }
      return false;
    }
  }

  async function recordStep(flow: Flow, step: StepBody): Promise<void> {
    const record = options.store.recordTransactionStep;
    if (!flow.journaled || record === undefined) return;
    const full = {
      ...step,
      transactionId: flow.transactionId,
      at: options.clock.nowIso(),
    } as TransactionStep;
    await safePersist(
      flow,
      () => record.call(options.store, full),
      `recordTransactionStep(${step.kind})`,
      'journal',
    );
  }

  async function finalizeHold(
    flow: Flow,
    hold: AuthorizationHold | undefined,
    action: HoldAction,
  ): Promise<void> {
    if (hold !== undefined && (await hold.finalize(action))) {
      await recordStep(flow, { kind: 'hold', hold: HOLD_STATES[action] });
    }
  }

  function buildEvent(
    flow: Flow,
    partial: Omit<CommerceEvent, 'id' | 'at' | 'requestId' | 'transactionId'>,
  ): CommerceEvent {
    return {
      id: options.ids.next('evt'),
      at: options.clock.nowIso(),
      requestId: flow.request.requestId,
      transactionId: flow.transactionId,
      ...partial,
    };
  }

  return { options, safeEmit, safePersist, recordStep, finalizeHold, buildEvent };
}
