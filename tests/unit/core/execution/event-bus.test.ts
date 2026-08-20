import { describe, expect, it } from 'vitest';
import type { CommerceEvent } from '../../../../src/core/domain/event.js';
import { createEventBus } from '../../../../src/core/execution/event-bus.js';
import { createCapturingLogger, createFakeStore } from './helpers.js';

function makeEvent(overrides: Partial<CommerceEvent> = {}): CommerceEvent {
  return {
    id: 'evt-1',
    type: 'resource.requested',
    requestId: 'req-1',
    at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('createEventBus', () => {
  it('persists events to the store and notifies subscribers', async () => {
    const store = createFakeStore();
    const logger = createCapturingLogger();
    const bus = createEventBus({ store, logger });

    const received: CommerceEvent[] = [];
    const unsubscribe = bus.subscribe((event) => received.push(event));

    const event = makeEvent();
    await bus.emit(event);

    expect(store.events).toEqual([event]);
    expect(received).toEqual([event]);

    unsubscribe();
    await bus.emit(makeEvent({ id: 'evt-2' }));
    expect(received).toHaveLength(1);
  });

  it('never throws when the store fails to persist, and still notifies subscribers', async () => {
    const store = createFakeStore({
      appendEvent: async () => {
        throw new Error('disk full');
      },
    });
    const logger = createCapturingLogger();
    const bus = createEventBus({ store, logger });

    const received: CommerceEvent[] = [];
    bus.subscribe((event) => received.push(event));

    await expect(bus.emit(makeEvent())).resolves.toBeUndefined();
    expect(received).toHaveLength(1);
    expect(logger.errors.length).toBeGreaterThan(0);
  });

  it('tolerates a non-Error value thrown by the store', async () => {
    const store = createFakeStore({
      appendEvent: async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'not-an-error-object';
      },
    });
    const logger = createCapturingLogger();
    const bus = createEventBus({ store, logger });

    await expect(bus.emit(makeEvent())).resolves.toBeUndefined();
    expect(logger.errors.length).toBeGreaterThan(0);
  });

  it('never throws when a subscriber throws', async () => {
    const store = createFakeStore();
    const logger = createCapturingLogger();
    const bus = createEventBus({ store, logger });

    bus.subscribe(() => {
      throw new Error('subscriber exploded');
    });

    await expect(bus.emit(makeEvent())).resolves.toBeUndefined();
    expect(store.events).toHaveLength(1);
    expect(logger.errors.length).toBeGreaterThan(0);
  });
});
