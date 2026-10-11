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
import { describeError } from '../../errors';
import type { BackendExecutor } from '../../interfaces/backend';
import type { Logger } from '../../interfaces/logger';
import type { Clock, IdGenerator } from '../../interfaces/runtime';
import type { ReceiptStore } from '../../interfaces/store';

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

/**
 * A reservation held across settlement, plus the summary the receipt keeps.
 * `finalize` ends it.
 */
export interface AuthorizationHold {
  readonly record: AuthorizationRecord;
  finalize(action: 'consume' | 'release' | 'markUncertain'): Promise<void>;
}

/** A verified, reserved payment and everything its settlement needs */
export interface SettleArgs {
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
  /** Runs a store write; a failure is logged, never thrown */
  readonly safePersist: (
    op: () => Promise<void>,
    label: string,
    requestId: string,
  ) => Promise<void>;
  readonly buildEvent: (partial: Omit<CommerceEvent, 'id' | 'at'>) => CommerceEvent;
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
    op: () => Promise<void>,
    label: string,
    requestId: string,
  ): Promise<void> {
    try {
      await op();
    } catch (error) {
      options.logger.error(
        { err: describeError(error), requestId },
        `Persistence failed: ${label}`,
      );
    }
  }

  function buildEvent(partial: Omit<CommerceEvent, 'id' | 'at'>): CommerceEvent {
    return { id: options.ids.next('evt'), at: options.clock.nowIso(), ...partial };
  }

  return { options, safeEmit, safePersist, buildEvent };
}
