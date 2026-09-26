import { describe, expect, it } from 'vitest';
import type { CommerceEvent } from '../../../../src/core/domain/event';
import { createStoreEventSink } from '../../../../src/core/execution/store-event-sink';
import { createCapturingLogger, createFakeStore } from './helpers';

function makeEvent(overrides: Partial<CommerceEvent> = {}): CommerceEvent {
  return {
    id: 'evt-1',
    type: 'resource.requested',
    requestId: 'req-1',
    at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('createStoreEventSink', () => {
  it('persists events to the store', async () => {
    const store = createFakeStore();
    const sink = createStoreEventSink({ store, logger: createCapturingLogger() });

    const event = makeEvent();
    await sink.emit(event);

    expect(store.events).toEqual([event]);
  });

  it('never throws when the store fails to persist', async () => {
    const store = createFakeStore({
      appendEvent: async () => {
        throw new Error('disk full');
      },
    });
    const logger = createCapturingLogger();
    const sink = createStoreEventSink({ store, logger });

    await expect(sink.emit(makeEvent())).resolves.toBeUndefined();
    expect(logger.errors.length).toBeGreaterThan(0);
  });

  it('tolerates a non-Error value thrown by the store', async () => {
    const store = createFakeStore({
      appendEvent: async () => {
        throw 'not-an-error-object';
      },
    });
    const logger = createCapturingLogger();
    const sink = createStoreEventSink({ store, logger });

    await expect(sink.emit(makeEvent())).resolves.toBeUndefined();
    expect(logger.errors.length).toBeGreaterThan(0);
  });
});
