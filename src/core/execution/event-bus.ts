/**
 * Fan-out `EventSink`: persists every event to the receipt store and notifies
 * in-process subscribers (the gateway's SSE feed). Never throws to the caller —
 * a store or subscriber failure is caught and logged.
 */
import type { CommerceEvent, EventSink } from '../domain/event.js';
import type { Logger } from '../interfaces/logger.js';
import type { Clock, IdGenerator } from '../interfaces/runtime.js';
import type { ReceiptStore } from '../interfaces/store.js';

export interface CreateEventBusOptions {
  readonly store: ReceiptStore;
  readonly logger: Logger;
  /** Reserved for callers that want the bus to mint ids/timestamps itself. */
  readonly ids?: IdGenerator;
  readonly clock?: Clock;
}

export interface EventBus extends EventSink {
  /** Subscribe to every emitted event. Returns an unsubscribe function. */
  subscribe(fn: (event: CommerceEvent) => void): () => void;
}

export function createEventBus(options: CreateEventBusOptions): EventBus {
  const subscribers = new Set<(event: CommerceEvent) => void>();

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

      for (const subscriber of subscribers) {
        try {
          subscriber(event);
        } catch (error) {
          options.logger.error(
            { err: describeError(error), eventType: event.type, requestId: event.requestId },
            'Event subscriber threw',
          );
        }
      }
    },

    subscribe(fn: (event: CommerceEvent) => void): () => void {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };
}

function describeError(error: unknown): { message: string; name?: string } {
  if (error instanceof Error) {
    return { message: error.message, name: error.name };
  }
  return { message: String(error) };
}
