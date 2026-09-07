/**
 * ACP checkout idempotency: the claim, the replay, and the two ways a key can
 * be refused.
 *
 * The store is exercised directly because that is where the semantics live -
 * atomic reservation, semantic fingerprints, retention - and once over the
 * adapter for the parts an operator actually observes.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createAcpAdapter } from '../../../src/protocols/acp/adapter.js';
import { ACP_SPEC_VERSION } from '../../../src/protocols/acp/constants.js';
import {
  identityHash,
  requestFingerprint,
} from '../../../src/protocols/acp/idempotency/fingerprint.js';
import {
  type AcpIdempotencyScope,
  createAcpIdempotencyStore,
} from '../../../src/protocols/acp/idempotency/store.js';
import { adapterOptions, delivered, setup } from './fixtures.js';

const IDENTITY = identityHash('acp-secret-token');
const SCOPE: AcpIdempotencyScope = {
  identityHash: IDENTITY,
  endpoint: '/acp/checkout_sessions',
  key: 'idem-1',
};
const FINGERPRINT = requestFingerprint({ currency: 'usd' });

function memoryStore(now?: () => number) {
  return createAcpIdempotencyStore({
    path: ':memory:',
    retentionHours: 24,
    ...(now !== undefined ? { now } : {}),
  });
}

describe('ACP idempotency store', () => {
  it('reserves an unseen key', () => {
    const store = memoryStore();
    expect(store.claim(SCOPE, FINGERPRINT)).toEqual({ kind: 'reserved' });
    store.close();
  });

  it('reports the first request as in flight while it is still running', () => {
    const store = memoryStore();
    store.claim(SCOPE, FINGERPRINT);
    expect(store.claim(SCOPE, FINGERPRINT)).toEqual({ kind: 'in-flight' });
    store.close();
  });

  it('replays the stored answer once the first request has completed', () => {
    const store = memoryStore();
    store.claim(SCOPE, FINGERPRINT);
    store.complete(SCOPE, { status: 201, body: { id: 'cs_1', status: 'ready_for_payment' } });

    expect(store.claim(SCOPE, FINGERPRINT)).toEqual({
      kind: 'replay',
      status: 201,
      body: { id: 'cs_1', status: 'ready_for_payment' },
    });
    store.close();
  });

  // A key reused for a different request is a conflict whether or not the
  // first one has finished: reporting "in flight" would invite a retry that
  // can only ever conflict.
  it.each([
    ['while the first is in flight', false],
    ['after the first has completed', true],
  ])('rejects a changed body %s', (_label, completeFirst) => {
    const store = memoryStore();
    store.claim(SCOPE, FINGERPRINT);
    if (completeFirst) store.complete(SCOPE, { status: 201, body: { id: 'cs_1' } });

    expect(store.claim(SCOPE, requestFingerprint({ currency: 'eur' }))).toEqual({
      kind: 'conflict',
    });
    store.close();
  });

  it('frees the key when the attempt is released, so a clean retry can run', () => {
    const store = memoryStore();
    store.claim(SCOPE, FINGERPRINT);
    store.release(SCOPE);

    expect(store.claim(SCOPE, FINGERPRINT)).toEqual({ kind: 'reserved' });
    store.close();
  });

  it.each([
    ['a different endpoint', { endpoint: '/acp/checkout_sessions/cs_1/cancel' }],
    ['a different caller', { identityHash: identityHash('another-token') }],
  ])('scopes a key by %s', (_label, override) => {
    const store = memoryStore();
    store.claim(SCOPE, FINGERPRINT);

    expect(store.claim({ ...SCOPE, ...override }, FINGERPRINT)).toEqual({ kind: 'reserved' });
    store.close();
  });

  it('expires records once the retention window has passed', () => {
    let clock = Date.parse('2026-01-01T00:00:00.000Z');
    const store = memoryStore(() => clock);
    store.claim(SCOPE, FINGERPRINT);
    store.complete(SCOPE, { status: 201, body: { id: 'cs_1' } });

    clock += 23 * 60 * 60 * 1000;
    expect(store.claim(SCOPE, FINGERPRINT)).toMatchObject({ kind: 'replay' });

    clock += 2 * 60 * 60 * 1000;
    expect(store.claim(SCOPE, FINGERPRINT)).toEqual({ kind: 'reserved' });
    store.close();
  });

  it('survives a reopen of the database file, and never writes the bearer token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-acp-idem-'));
    const path = join(dir, 'acp-idempotency.sqlite');

    const first = createAcpIdempotencyStore({ path, retentionHours: 24 });
    first.claim(SCOPE, FINGERPRINT);
    first.complete(SCOPE, { status: 201, body: { id: 'cs_1' } });
    first.close();

    const second = createAcpIdempotencyStore({ path, retentionHours: 24 });
    expect(second.claim(SCOPE, FINGERPRINT)).toMatchObject({ kind: 'replay', status: 201 });
    second.close();

    // Only the digest of the token may be persisted.
    const bytes = readFileSync(path).toString('binary');
    expect(bytes).not.toContain('acp-secret-token');
    expect(bytes).toContain(IDENTITY);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('ACP request fingerprints', () => {
  it.each([
    ['object key order', { a: 1, b: 2 }, { b: 2, a: 1 }],
    ['nested key order', { outer: { a: 1, b: 2 } }, { outer: { b: 2, a: 1 } }],
    ['equivalent number spellings', { amount: 100 }, { amount: 1e2 }],
    ['integral floats', { quantity: 1 }, { quantity: 1.0 }],
  ])('treats %s as the same request', (_label, left, right) => {
    expect(requestFingerprint(left)).toBe(requestFingerprint(right));
  });

  it.each([
    ['array order', [1, 2], [2, 1]],
    ['null against an absent property', { a: null }, {}],
    ['a number against its string', { a: 1 }, { a: '1' }],
    ['a boolean against a string', { a: true }, { a: 'true' }],
    ['an empty array against an empty object', [], {}],
  ])('treats %s as different requests', (_label, left, right) => {
    expect(requestFingerprint(left)).not.toBe(requestFingerprint(right));
  });
});

describe('ACP idempotency over the adapter', () => {
  async function post(
    adapter: ReturnType<typeof createAcpAdapter>,
    key: string,
    body: unknown,
  ): Promise<{ status: number; headers: Record<string, string> }> {
    let status = 0;
    let headers: Record<string, string> = {};
    const res = {
      headersSent: false,
      writeHead(code: number, sent?: Record<string, string>) {
        status = code;
        headers = sent ?? {};
        return res;
      },
      end() {
        return res;
      },
    };
    const payload = JSON.stringify(body);
    const req = Object.assign(
      (async function* () {
        yield Buffer.from(payload, 'utf8');
      })(),
      {
        method: 'POST',
        url: '/acp/checkout_sessions',
        headers: {
          authorization: 'Bearer acp-secret-token',
          'api-version': ACP_SPEC_VERSION,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
      },
    );
    await adapter.handleHttp(req as never, res as never);
    return { status, headers };
  }

  const CREATE = { line_items: [{ id: 'item_123' }], currency: 'usd', capabilities: {} };

  it('echoes the Idempotency-Key it accepted', async () => {
    const adapter = createAcpAdapter(adapterOptions());
    await adapter.start(setup(delivered({ id: 'cs_1' })).context);

    const result = await post(adapter, 'idem-echo', CREATE);
    expect(result.headers['idempotency-key']).toBe('idem-echo');
    expect(result.headers['idempotent-replayed']).toBeUndefined();
    await adapter.stop();
  });

  it('replays the first answer for a repeat of the same request', async () => {
    const { context, execute } = setup(delivered({ id: 'cs_1', status: 'ready_for_payment' }));
    const adapter = createAcpAdapter(adapterOptions());
    await adapter.start(context);

    const first = await post(adapter, 'idem-replay', CREATE);
    const second = await post(adapter, 'idem-replay', CREATE);

    expect(first.status).toBe(200);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    // The whole point: the merchant backend was called once, not twice.
    expect(execute).toHaveBeenCalledTimes(1);
    await adapter.stop();
  });

  it('refuses a key reused for a different body, without executing again', async () => {
    const { context, execute } = setup(delivered({ id: 'cs_1' }));
    const adapter = createAcpAdapter(adapterOptions());
    await adapter.start(context);

    await post(adapter, 'idem-conflict', CREATE);
    const conflict = await post(adapter, 'idem-conflict', { ...CREATE, currency: 'eur' });

    expect(conflict.status).toBe(422);
    expect(execute).toHaveBeenCalledTimes(1);
    await adapter.stop();
  });

  // A transient 5xx must not poison the key for the whole retention window:
  // the second attempt must get to run, not be told the first is in flight.
  it('does not cache a 5xx answer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-acp-adapter-'));
    const path = join(dir, 'idem.sqlite');
    const adapter = createAcpAdapter(adapterOptions({ idempotency: { path, retentionHours: 24 } }));
    await adapter.start(setup(new Error('backend exploded')).context);

    // The pipeline throws for this context, so both attempts answer 500.
    const first = await post(adapter, 'idem-5xx', CREATE);
    const second = await post(adapter, 'idem-5xx', CREATE);

    expect(first.status).toBe(500);
    expect(second.status).toBe(500);
    expect(second.headers['idempotent-replayed']).toBeUndefined();

    // The store really is in the request path, and the released claim left
    // nothing behind: a row here would block the key for the whole window.
    await adapter.stop();
    const db = new Database(path, { readonly: true });
    const rows = db.prepare('SELECT COUNT(*) AS count FROM acp_idempotency').get() as {
      count: number;
    };
    db.close();
    expect(rows.count).toBe(0);

    rmSync(dir, { recursive: true, force: true });
  });
});
