// Track returnImmediately work independently of HTTP request completion.
// Bound it per adapter because the gateway mount counts only active requests.
import type { Logger } from '../../core';
import { toLogInfo } from '../../core/errors';

export interface BackgroundRuns {
  /** Reserve capacity before returning a working task; false when full */
  reserve(): boolean;
  /** Release an unused reservation */
  release(): void;
  /** Start work in a reserved slot; release it when the returned promise settles */
  start(work: () => Promise<unknown>): void;
  /** Wait for started runs to settle, including those started while waiting */
  settled(): Promise<void>;
}

export function createBackgroundRuns(limit: number, logger: Logger): BackgroundRuns {
  let claimed = 0;
  const runs = new Set<Promise<void>>();
  return {
    reserve() {
      if (claimed >= limit) return false;
      claimed += 1;
      return true;
    },
    release() {
      claimed -= 1;
    },
    start(work) {
      const run: Promise<void> = work()
        .then(
          () => undefined,
          // Callers record task outcomes; log unexpected rejections at error
          (err: unknown) => {
            logger.error({ err: toLogInfo(err) }, 'a2a adapter: background task failed');
          },
        )
        .finally(() => {
          claimed -= 1;
          runs.delete(run);
        });
      runs.add(run);
    },
    async settled() {
      while (runs.size > 0) await Promise.allSettled([...runs]);
    },
  };
}
