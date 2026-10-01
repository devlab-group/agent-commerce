import { describe, expect, it } from 'vitest';
import { UnauthorizedError } from '../src/lib/api';
import { pollEvents } from '../src/lib/event-poll';
import type { CommerceEvent } from '../src/lib/types';

function makeEvent(id: string): CommerceEvent {
  return { id, type: 'resource.delivered', requestId: 'req1', at: '2026-01-01T00:00:00.000Z' };
}

// Settles the fetchEvents().then(...) chain
const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

function harness(fetchEvents: () => Promise<readonly CommerceEvent[]>) {
  const received: string[] = [];
  const authErrors: string[] = [];
  let succeeded = 0;
  let tick: (() => void) | undefined;
  let cleared = false;
  const stop = pollEvents('http://gw', (event) => received.push(event.id), {
    fetchEvents,
    setIntervalFn: (fn) => {
      tick = fn;
      return 1;
    },
    clearIntervalFn: () => {
      cleared = true;
    },
    onAuthError: (message) => authErrors.push(message),
    onPollSucceeded: () => {
      succeeded++;
    },
  });
  return {
    received,
    authErrors,
    succeeded: () => succeeded,
    stop,
    tick: () => tick?.(),
    cleared: () => cleared,
  };
}

describe('pollEvents', () => {
  it('polls at once and then on every interval', () => {
    let calls = 0;
    const h = harness(async () => {
      calls++;
      return [];
    });
    expect(calls).toBe(1);
    h.tick();
    expect(calls).toBe(2);
  });

  it('delivers a newest-first batch oldest first, so a prepending feed shows the newest on top', async () => {
    const h = harness(async () => [makeEvent('e3'), makeEvent('e2'), makeEvent('e1')]);
    await flush();
    expect(h.received).toEqual(['e1', 'e2', 'e3']);
  });

  it('drops events an earlier poll already delivered', async () => {
    let batch = [makeEvent('e1')];
    const h = harness(async () => batch);
    await flush();
    batch = [makeEvent('e2'), makeEvent('e1')];
    h.tick();
    await flush();
    expect(h.received).toEqual(['e1', 'e2']);
  });

  it('forgets the oldest ids past the cap instead of growing without bound', async () => {
    let batch: CommerceEvent[] = Array.from({ length: 1001 }, (_, i) => makeEvent(`e${i}`));
    const h = harness(async () => batch);
    await flush();
    // e1000 was the oldest (last in the newest-first batch), so the cap evicted it
    batch = [makeEvent('e1000'), makeEvent('e0')];
    h.tick();
    await flush();
    expect(h.received.slice(1001)).toEqual(['e1000']);
  });

  it('reports a rejected admin token and keeps polling', async () => {
    let calls = 0;
    const h = harness(async () => {
      calls++;
      throw new UnauthorizedError('http://gw/api/events');
    });
    await flush();
    h.tick();
    await flush();
    expect(h.authErrors).toHaveLength(2);
    expect(h.authErrors[0]).toMatch(/admin token/i);
    expect(calls).toBe(2);
  });

  it('reports a successful poll after a rejected one, so the UI can clear the error', async () => {
    let calls = 0;
    const h = harness(async () => {
      calls++;
      if (calls === 1) throw new UnauthorizedError('http://gw/api/events');
      return [];
    });
    await flush();
    expect(h.authErrors).toHaveLength(1);
    expect(h.succeeded()).toBe(0);
    h.tick();
    await flush();
    expect(h.succeeded()).toBe(1);
  });

  it('ignores any other poll failure', async () => {
    const h = harness(async () => {
      throw new Error('network down');
    });
    await flush();
    expect(h.authErrors).toHaveLength(0);
    expect(h.received).toHaveLength(0);
  });

  it('clears the interval when the returned stop function runs', () => {
    const h = harness(async () => []);
    h.stop();
    expect(h.cleared()).toBe(true);
  });
});
