// Run the ReceiptStore conformance cases against SQLite files and in memory
import { AssertionError } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PaymentAttemptReservation } from '../../../src/core/public-types';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import { type ConformanceStoreFactory, receiptStoreConformanceCases } from '../../../src/testing';

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

describe('the conformance runner', () => {
  it('closes a store whose init() throws', async () => {
    const closed: string[] = [];
    const [first] = await receiptStoreConformanceCases(() => {
      const store = createSqliteReceiptStore({ path: ':memory:' });
      return {
        store: Object.assign(store, {
          init: async () => {
            throw new Error('schema mismatch');
          },
          close: async () => {
            closed.push('closed');
          },
        }),
      };
    });

    // The probe store was closed while the cases were built
    closed.length = 0;

    await expect(first?.run()).rejects.toThrow('schema mismatch');
    expect(closed).toEqual(['closed']);
  });

  it('fails a store that reserves one replay key twice', async () => {
    let n = 0;
    const cases = await receiptStoreConformanceCases(({ clock }) => {
      const store = createSqliteReceiptStore({ path: ':memory:', clock });
      const reserve = store.reservePaymentAttempt.bind(store);
      // Give each call a unique key so repeated input bypasses replay protection
      return {
        store: Object.assign(store, {
          reservePaymentAttempt: (r: PaymentAttemptReservation) =>
            reserve({ ...r, replayKey: `${r.replayKey}#${++n}` }),
        }),
      };
    });
    const replayCases = cases.filter((c) =>
      [
        'a second reservation of a replay key is refused',
        'concurrent reservations of one replay key let exactly one win',
      ].includes(c.name),
    );

    expect(replayCases).toHaveLength(2);
    for (const c of replayCases) await expect(c.run()).rejects.toBeInstanceOf(AssertionError);
  });

  it('skips the claim reads for a store without getIdempotencyKey, whose claim group stays whole', async () => {
    const cases = await receiptStoreConformanceCases(({ clock }) => ({
      store: Object.assign(createSqliteReceiptStore({ path: ':memory:', clock }), {
        getIdempotencyKey: undefined,
      }),
    }));

    expect(cases.filter((c) => c.skip?.includes('getIdempotencyKey')).map((c) => c.name)).toEqual([
      'reading an idempotency scope answers as a claim would and creates nothing',
      'an expired completed claim reads as absent, and other states never expire',
      'recovery with an endpoint prefix leaves other endpoints alone',
      'an endpoint prefix is literal text',
    ]);
    const groups = cases.find((c) => c.name.startsWith('implements each optional method group'));
    await expect(groups?.run()).resolves.toBeUndefined();
  });
});
