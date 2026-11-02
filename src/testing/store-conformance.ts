/**
 * Receipt store conformance cases for use with any test runner. Each case has
 * a name, an optional skip reason and a `run()` using `node:assert/strict`.
 * For example, wrap them with Vitest:
 *
 * ```ts
 * const cases = await receiptStoreConformanceCases(open);
 * for (const c of cases) it.skipIf(c.skip !== undefined)(c.name, () => c.run());
 * ```
 */
import type { Clock, ReceiptStore } from '../core';
import { STORE_METHOD_GROUPS } from '../core/store-method-groups';
import { CORE_CASES } from './conformance/core-cases';
import { RECORD_CASES } from './conformance/record-cases';
import { type CaseSpec, createConformanceClock } from './conformance/support';

/** Experimental: may change in a minor release */
export interface ConformanceContext {
  /** Pass it to the store: expiry cases move it instead of waiting */
  readonly clock: Clock;
}

/** Experimental: may change in a minor release */
export interface ConformanceStore {
  /** A new, empty store; the suite calls `init()` and `close()` */
  readonly store: ReceiptStore;
  /**
   * Close the current store and return a new one using the same data.
   * Durability cases are skipped when this function is absent.
   */
  readonly reopen?: () => Promise<ReceiptStore>;
}

/**
 * Creates stores for capability discovery and individual cases. Experimental:
 * may change in a minor release.
 */
export type ConformanceStoreFactory = (
  context: ConformanceContext,
) => ConformanceStore | Promise<ConformanceStore>;

/** Experimental: may change in a minor release */
export interface ConformanceCase {
  readonly name: string;
  /** Why the case does not apply to this store. Report it as skipped, never as passed */
  readonly skip?: string;
  run(): Promise<void>;
}

/** Method groups a store implements completely or not at all */
export const METHOD_GROUPS = STORE_METHOD_GROUPS;

const implemented = (store: ReceiptStore, method: keyof ReceiptStore): boolean =>
  typeof store[method] === 'function';

const GROUP_CASE: CaseSpec = {
  name: 'implements each optional method group completely or not at all',
  async run({ store }) {
    for (const [group, methods] of Object.entries(METHOD_GROUPS)) {
      const present = methods.filter((m) => implemented(store, m));
      if (present.length !== 0 && present.length !== methods.length) {
        throw new Error(`${group}: implements ${present.join(', ')} but not the rest of the group`);
      }
    }
  },
};

/**
 * Build cases for the stores `open` creates. Probe one store to identify its
 * optional methods and whether the factory supports reopening. Experimental:
 * may change in a minor release.
 */
export async function receiptStoreConformanceCases(
  open: ConformanceStoreFactory,
): Promise<readonly ConformanceCase[]> {
  const probe = await open({ clock: createConformanceClock() });
  const canReopen = probe.reopen !== undefined;
  const missing = (spec: CaseSpec): string | undefined => {
    const absent = (spec.uses ?? []).filter((m) => !implemented(probe.store, m));
    if (absent.length > 0) return `the store does not implement ${absent.join(', ')}`;
    if (spec.needsReopen === true && !canReopen) return 'the factory supplies no reopen()';
    return undefined;
  };
  const cases = [GROUP_CASE, ...CORE_CASES, ...RECORD_CASES].map((spec): ConformanceCase => {
    const skip = missing(spec);
    return {
      name: spec.name,
      ...(skip !== undefined ? { skip } : {}),
      run: () => runCase(open, spec),
    };
  });
  await probe.store.close();
  return cases;
}

async function runCase(open: ConformanceStoreFactory, spec: CaseSpec): Promise<void> {
  const clock = createConformanceClock();
  const opened = await open({ clock });
  let current = opened.store;
  try {
    // Inside the try, so a store whose init() throws is still closed
    await current.init();
    await spec.run({
      store: current,
      clock,
      async reopen() {
        if (opened.reopen === undefined) throw new Error('the factory supplies no reopen()');
        current = await opened.reopen();
        await current.init();
        return current;
      },
    });
  } finally {
    await current.close();
  }
}
