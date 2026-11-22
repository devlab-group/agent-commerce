import { describe, expect, it } from 'vitest';
import type { ReceiptStore } from '../../../src/core';
import { hasMethodGroup, STORE_METHOD_GROUPS } from '../../../src/core/store-method-groups';
import { receiptStoreConformanceCases } from '../../../src/testing/store-conformance';

const noop = async () => undefined;
const TASK_RECORDS = { putTaskRecord: noop, getTaskRecord: noop, listTaskRecords: noop };

describe('the task_records method group', () => {
  it('is present only when every method of the group is', () => {
    expect(hasMethodGroup(TASK_RECORDS as unknown as ReceiptStore, 'task_records')).toBe(true);
    for (const method of STORE_METHOD_GROUPS.task_records) {
      const partial = { ...TASK_RECORDS, [method]: undefined } as unknown as ReceiptStore;
      expect(hasMethodGroup(partial, 'task_records')).toBe(false);
    }
    expect(hasMethodGroup(undefined, 'task_records')).toBe(false);
  });

  it('fails the conformance group case for a store implementing part of it', async () => {
    const store = {
      init: noop,
      close: noop,
      putTaskRecord: noop,
      getTaskRecord: noop,
    } as unknown as ReceiptStore;
    const cases = await receiptStoreConformanceCases(() => ({ store }));
    const group = cases.find((c) => c.name.includes('method group completely or not at all'));
    await expect(group?.run()).rejects.toThrow(
      'task_records: implements putTaskRecord, getTaskRecord but not the rest of the group',
    );
  });
});
