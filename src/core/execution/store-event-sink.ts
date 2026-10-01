/**
 * `EventSink` that persists every event to the receipt store. A store failure
 * is logged, never thrown to the caller.
 */
import type { CommerceEvent, EventSink } from '../domain/event';
import { describeError } from '../errors';
import type { Logger } from '../interfaces/logger';
import type { ReceiptStore } from '../interfaces/store';

export interface CreateStoreEventSinkOptions {
  readonly store: ReceiptStore;
  readonly logger: Logger;
}

export function createStoreEventSink(options: CreateStoreEventSinkOptions): EventSink {
  return {
    async emit(event: CommerceEvent): Promise<void> {
      try {
        await options.store.appendEvent(event);
      } catch (error) {
        options.logger.error(
          { err: describeError(error), eventType: event.type, requestId: event.requestId },
          'Failed to persist commerce event',
        );
      }
    },
  };
}
