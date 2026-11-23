import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/core';
import { createBackgroundRuns } from '../../../src/protocols/a2a/background';

function logger(): Logger & { error: ReturnType<typeof vi.fn> } {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
  };
  return log;
}

// Let the test resolve or reject a run on demand
function deferred() {
  let resolve = () => {};
  let reject: (err: unknown) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createBackgroundRuns', () => {
  it('refuses a slot at the limit and gives one back on release', () => {
    const runs = createBackgroundRuns(2, logger());

    expect([runs.reserve(), runs.reserve(), runs.reserve()]).toEqual([true, true, false]);
    runs.release();
    expect(runs.reserve()).toBe(true);
  });

  it('frees a slot when its run settles, whether it resolves or rejects', async () => {
    const log = logger();
    const runs = createBackgroundRuns(2, log);
    const ok = deferred();
    const bad = deferred();
    runs.reserve();
    runs.start(() => ok.promise);
    runs.reserve();
    runs.start(() => bad.promise);
    expect(runs.reserve()).toBe(false);

    ok.resolve();
    bad.reject(new Error('backend gone'));
    await runs.settled();

    expect([runs.reserve(), runs.reserve(), runs.reserve()]).toEqual([true, true, false]);
    expect(log.error).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith(
      { err: expect.objectContaining({ code: 'INTERNAL_ERROR' }) },
      'a2a adapter: background task failed',
    );
  });

  it('settles only after every run, including one started while it waits', async () => {
    const runs = createBackgroundRuns(2, logger());
    const first = deferred();
    const second = deferred();
    runs.reserve();
    runs.start(() => first.promise);
    let settled = false;
    const waiting = runs.settled().then(() => {
      settled = true;
    });

    runs.reserve();
    runs.start(() => second.promise);
    first.resolve();
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    second.resolve();
    await waiting;

    expect(settled).toBe(true);
  });

  it('settles at once with no runs', async () => {
    await expect(createBackgroundRuns(1, logger()).settled()).resolves.toBeUndefined();
  });
});
