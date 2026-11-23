// Test the memory fallback for task records and the adapter's retention limits
import { describe, expect, it } from 'vitest';
import type { Clock } from '../../../src/core';
import { createA2aAdapter } from '../../../src/protocols/a2a';
import { createMemoryTasks, createStoredTasks } from '../../../src/protocols/a2a/task-store';
import type { A2aTask } from '../../../src/protocols/a2a/types';

const START = Date.parse('2026-11-22T10:00:00.000Z');

function createClock() {
  let now = START;
  const clock: Clock = {
    now: () => new Date(now),
    nowIso: () => new Date(now).toISOString(),
    monotonicMs: () => now,
  };
  return { clock, advance: (ms: number) => (now += ms) };
}

function task(id: string, contextId = 'context-1', state = 'TASK_STATE_COMPLETED'): A2aTask {
  return {
    id,
    contextId,
    status: { state, timestamp: new Date(START).toISOString() },
    artifacts: [],
  };
}

const at = (ms: number) => new Date(START + ms).toISOString();

describe('createMemoryTasks', () => {
  it('returns a task until it expires, and not at its expiry', async () => {
    const time = createClock();
    const tasks = createMemoryTasks(time.clock, 10);
    await tasks.put(task('a'), at(1000));

    time.advance(999);
    expect(await tasks.get('a')).toEqual(task('a'));
    expect(await tasks.list('context-1')).toEqual([task('a')]);
    time.advance(1);
    expect(await tasks.get('a')).toBeUndefined();
    expect(await tasks.list('context-1')).toEqual([]);
  });

  it("lists only the named context's tasks", async () => {
    const tasks = createMemoryTasks(createClock().clock, 10);
    await tasks.put(task('a', 'context-1'), at(1000));
    await tasks.put(task('b', 'context-2'), at(1000));

    expect(await tasks.list('context-2')).toEqual([task('b', 'context-2')]);
    expect(await tasks.list('context-3')).toEqual([]);
  });

  it('refuses a new task at the cap and keeps the ones it holds', async () => {
    const tasks = createMemoryTasks(createClock().clock, 2);
    await tasks.put(task('a'), at(1000));
    await tasks.put(task('b'), at(1000));

    expect(await tasks.put(task('c'), at(1000))).toBe(false);
    expect(await tasks.get('c')).toBeUndefined();
    expect(await tasks.get('a')).toEqual(task('a'));
    expect(await tasks.get('b')).toEqual(task('b'));
  });

  it('replaces a task at the cap, since it takes no new place', async () => {
    const tasks = createMemoryTasks(createClock().clock, 1);
    await tasks.put(task('a'), at(1000));

    const failed = task('a', 'context-1', 'TASK_STATE_FAILED');
    expect(await tasks.put(failed, at(2000))).toBe(true);
    expect(await tasks.get('a')).toEqual(failed);
  });

  it('frees the places of expired tasks at the cap', async () => {
    const time = createClock();
    const tasks = createMemoryTasks(time.clock, 1);
    await tasks.put(task('a'), at(1000));

    time.advance(1000);
    expect(await tasks.put(task('b'), at(5000))).toBe(true);
    expect(await tasks.get('b')).toEqual(task('b'));
  });

  it('evicts the earliest written evictable task at the cap, then refuses', async () => {
    const tasks = createMemoryTasks(createClock().clock, 3);
    await tasks.put(task('free-1'), at(1000), true);
    await tasks.put(task('paid'), at(1000));
    await tasks.put(task('free-2'), at(1000), true);

    expect(await tasks.put(task('next'), at(1000))).toBe(true);
    expect(await tasks.get('free-1')).toBeUndefined();
    expect(await tasks.put(task('last'), at(1000), true)).toBe(true);
    expect(await tasks.get('free-2')).toBeUndefined();
    // `last` is evictable, then nothing is
    expect(await tasks.put(task('one-more'), at(1000))).toBe(true);
    expect(await tasks.put(task('refused'), at(1000), true)).toBe(false);
    expect(await tasks.get('paid')).toEqual(task('paid'));
  });

  it('counts a replacement as a new write, and takes its evictable flag', async () => {
    const tasks = createMemoryTasks(createClock().clock, 2);
    await tasks.put(task('a', 'context-1', 'TASK_STATE_WORKING'), at(1000), true);
    await tasks.put(task('b'), at(1000), true);
    await tasks.put(task('a'), at(1000), true);

    // `b` is now the earliest written
    expect(await tasks.put(task('c'), at(1000))).toBe(true);
    expect(await tasks.get('b')).toBeUndefined();
    await tasks.put(task('a'), at(1000));
    expect(await tasks.put(task('d'), at(1000))).toBe(false);
  });
});

describe('createStoredTasks', () => {
  it("reads another protocol's record as no task", async () => {
    const record = {
      id: 'a',
      protocol: 'acp' as const,
      groupId: 'context-1',
      state: 'completed',
      updatedAt: at(0),
      document: { id: 'a' },
      expiresAt: at(1000),
    };
    const tasks = createStoredTasks(
      {
        putTaskRecord: async () => true,
        getTaskRecord: async () => record,
        listTaskRecords: async () => [],
      },
      10,
    );

    expect(await tasks.get('a')).toBeUndefined();
  });
});

describe('the adapter tasks option', () => {
  it.each([
    ['retentionHours', 0],
    ['retentionHours', 8761],
    ['retentionHours', 1.5],
    ['maxRetained', 0],
    ['maxRetained', 1_000_001],
    ['maxRetained', Number.NaN],
  ])('refuses %s %d with CONFIG_INVALID naming the option', (name, value) => {
    expect(() => createA2aAdapter({ tasks: { [name]: value } })).toThrow(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        details: { path: `tasks.${name}` },
      }),
    );
  });

  it.each([
    ['retentionHours', 1],
    ['retentionHours', 8760],
    ['maxRetained', 1],
    ['maxRetained', 1_000_000],
  ])('accepts %s %d', (name, value) => {
    expect(() => createA2aAdapter({ tasks: { [name]: value } })).not.toThrow();
  });
});
