/**
 * `@devlab.group/agent-commerce/testing` exports conformance cases for custom
 * `ReceiptStore` implementations. They use `node:assert/strict` without
 * importing a test runner, so you can wrap them with your runner.
 * Experimental: may change in a minor release.
 *
 *   import { receiptStoreConformanceCases } from '@devlab.group/agent-commerce/testing';
 *
 *   const cases = await receiptStoreConformanceCases(({ clock }) => ({ store: open(clock) }));
 *   for (const c of cases) it.skipIf(c.skip !== undefined)(c.name, () => c.run());
 */

export {
  type ConformanceCase,
  type ConformanceContext,
  type ConformanceStore,
  type ConformanceStoreFactory,
  receiptStoreConformanceCases,
} from './testing/store-conformance';
