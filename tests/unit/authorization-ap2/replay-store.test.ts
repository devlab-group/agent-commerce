/**
 * One mandate authorises one settlement. These are the ways a second could be
 * got out of the same approval, and the state machine that refuses them.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Ap2ReplayStore,
  type Ap2ReservationRequest,
  createAp2ReplayStore,
} from '../../../src/authorization/ap2/replay-store.js';

const scratch = mkdtempSync(join(tmpdir(), 'ap2-replay-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function request(overrides: Partial<Ap2ReservationRequest> = {}): Ap2ReservationRequest {
  return {
    reference: 'sha256:AAAA',
    checkoutJti: 'checkout_01',
    mandateIssuer: 'https://trusted-surface.example',
    checkoutIssuer: 'https://merchant.example',
    resourceId: 'market_report',
    requestId: 'req-1',
    ...overrides,
  };
}

let store: Ap2ReplayStore;
beforeEach(() => {
  store = createAp2ReplayStore({ path: ':memory:' });
});

describe('reserving', () => {
  it('accepts a mandate never seen before', () => {
    expect(store.reserve(request())).toEqual({ kind: 'reserved' });
    expect(store.stateOf('sha256:AAAA')).toBe('reserved');
  });

  it('refuses the same mandate while a first reservation is still open', () => {
    store.reserve(request());
    expect(store.reserve(request({ requestId: 'req-2' }))).toEqual({
      kind: 'replayed',
      state: 'reserved',
    });
  });

  it('refuses a mandate that has already been spent', () => {
    store.reserve(request());
    store.consume('sha256:AAAA');
    expect(store.reserve(request({ requestId: 'req-2' }))).toEqual({
      kind: 'replayed',
      state: 'consumed',
    });
  });

  it('refuses a mandate whose settlement outcome was never learned', () => {
    // The buyer may well have paid. Handing it back risks a second payment
    // for one approval, which is worth refusing a legitimate retry to avoid.
    store.reserve(request());
    store.markUncertain('sha256:AAAA');
    expect(store.reserve(request({ requestId: 'req-2' }))).toEqual({
      kind: 'replayed',
      state: 'uncertain',
    });
  });

  it('lets a released mandate be presented again, which is the retry path', () => {
    store.reserve(request());
    store.release('sha256:AAAA');
    expect(store.reserve(request({ requestId: 'req-2' }))).toEqual({ kind: 'reserved' });
    expect(store.stateOf('sha256:AAAA')).toBe('reserved');
  });

  it('refuses a different mandate that binds a checkout already in flight', () => {
    // Two mandates, one checkout document: different references, so the
    // reference alone would let the second through
    store.reserve(request());
    expect(store.reserve(request({ reference: 'sha256:BBBB', requestId: 'req-2' }))).toEqual({
      kind: 'replayed',
      state: 'reserved',
    });
  });

  it('refuses a different mandate binding a checkout that was already spent', () => {
    store.reserve(request());
    store.consume('sha256:AAAA');
    expect(store.reserve(request({ reference: 'sha256:BBBB', requestId: 'req-2' }))).toEqual({
      kind: 'replayed',
      state: 'consumed',
    });
  });

  it('allows a different mandate for a checkout whose reservation was released', () => {
    store.reserve(request());
    store.release('sha256:AAAA');
    expect(store.reserve(request({ reference: 'sha256:BBBB', requestId: 'req-2' }))).toEqual({
      kind: 'reserved',
    });
  });

  it('keeps unrelated mandates independent', () => {
    expect(store.reserve(request())).toEqual({ kind: 'reserved' });
    expect(
      store.reserve(
        request({ reference: 'sha256:CCCC', checkoutJti: 'checkout_02', requestId: 'req-2' }),
      ),
    ).toEqual({ kind: 'reserved' });
  });
});

describe('finalising', () => {
  it('never lets a consumed mandate be released back into circulation', () => {
    // Stops a backend failure after settlement handing back a spent mandate
    store.reserve(request());
    store.consume('sha256:AAAA');
    store.release('sha256:AAAA');
    expect(store.stateOf('sha256:AAAA')).toBe('consumed');
  });

  it('never lets an uncertain mandate be released', () => {
    store.reserve(request());
    store.markUncertain('sha256:AAAA');
    store.release('sha256:AAAA');
    expect(store.stateOf('sha256:AAAA')).toBe('uncertain');
  });

  it('never lets a released mandate be consumed without a fresh reservation', () => {
    store.reserve(request());
    store.release('sha256:AAAA');
    store.consume('sha256:AAAA');
    expect(store.stateOf('sha256:AAAA')).toBe('released');
  });

  it('ignores a finalise for a mandate nobody reserved', () => {
    store.consume('sha256:NEVER');
    expect(store.stateOf('sha256:NEVER')).toBeUndefined();
  });
});

describe('durability', () => {
  it('still refuses a consumed mandate after the database is reopened', () => {
    const path = join(scratch, 'reopen.sqlite');
    const first = createAp2ReplayStore({ path });
    first.reserve(request());
    first.consume('sha256:AAAA');
    first.close();

    const second = createAp2ReplayStore({ path });
    expect(second.stateOf('sha256:AAAA')).toBe('consumed');
    expect(second.reserve(request({ requestId: 'req-2' }))).toEqual({
      kind: 'replayed',
      state: 'consumed',
    });
    second.close();
    expect(existsSync(path)).toBe(true);
  });

  it('reopens an existing file without re-running the migration', () => {
    const path = join(scratch, 'migrate-once.sqlite');
    const first = createAp2ReplayStore({ path });
    first.reserve(request());
    first.close();
    const second = createAp2ReplayStore({ path });
    expect(second.stateOf('sha256:AAAA')).toBe('reserved');
    second.close();
  });
});

describe('what is written down', () => {
  it('stores identifiers and a digest, never the mandate itself', () => {
    // A leaked database must not hand anyone a mandate, its disclosures, the
    // checkout JWT, or anything about the buyer
    const path = join(scratch, 'contents.sqlite');
    const s = createAp2ReplayStore({ path });
    s.reserve(request());
    s.close();

    const db = new Database(path);
    const columns = (
      db.prepare('SELECT name FROM pragma_table_info(?)').all('ap2_authorizations') as {
        name: string;
      }[]
    ).map((c) => c.name);
    db.close();

    expect(columns.sort()).toEqual([
      'checkout_issuer',
      'checkout_jti',
      'created_at',
      'mandate_issuer',
      'reference',
      'request_id',
      'resource_id',
      'state',
      'updated_at',
    ]);
    for (const forbidden of ['mandate', 'presentation', 'checkout_jwt', 'disclosure', 'payload']) {
      expect(columns).not.toContain(forbidden);
    }
  });

  it('rejects a state the schema does not know', () => {
    const path = join(scratch, 'check.sqlite');
    const s = createAp2ReplayStore({ path });
    s.reserve(request());
    s.close();

    const db = new Database(path);
    expect(() =>
      db.prepare("UPDATE ap2_authorizations SET state = 'spent-ish'").run(),
    ).toThrowError(/CHECK/i);
    db.close();
  });
});
