// Run the ReceiptStore conformance cases against SQLite files and in memory
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import {
  type ConformanceStoreFactory,
  receiptStoreConformanceCases,
} from '../../../src/testing/store-conformance';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const fileBacked: ConformanceStoreFactory = ({ clock }) => {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-store-conformance-'));
  dirs.push(dir);
  const path = join(dir, 'receipts.sqlite');
  let current = createSqliteReceiptStore({ path, clock });
  return {
    store: current,
    async reopen() {
      await current.close();
      current = createSqliteReceiptStore({ path, clock });
      return current;
    },
  };
};

const inMemory: ConformanceStoreFactory = ({ clock }) => ({
  store: createSqliteReceiptStore({ path: ':memory:', clock }),
});

const fileCases = await receiptStoreConformanceCases(fileBacked);
const memoryCases = await receiptStoreConformanceCases(inMemory);

describe('SQLite receipt store conformance, file-backed', () => {
  it('applies every case', () => {
    expect(fileCases.filter((c) => c.skip !== undefined)).toEqual([]);
  });
  for (const c of fileCases) it(c.name, () => c.run());
});

describe('SQLite receipt store conformance, in memory', () => {
  it('skips only the cases that need reopen()', () => {
    const skips = new Set(memoryCases.flatMap((c) => (c.skip !== undefined ? [c.skip] : [])));
    expect([...skips].every((reason) => reason === 'the factory supplies no reopen()')).toBe(true);
  });
  for (const c of memoryCases) it.skipIf(c.skip !== undefined)(c.name, () => c.run());
});
