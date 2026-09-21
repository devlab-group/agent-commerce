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
  operationKey,
  requestFingerprint,
} from '../../../src/protocols/acp/idempotency/fingerprint.js';
import {
  type AcpIdempotencyScope,
  createAcpIdempotencyStore,
} from '../../../src/protocols/acp/idempotency/store.js';
import { adapterOptions, deliveredFor, setup } from './fixtures.js';

const DEPLOYMENT = 'https://merchant.example.com';
const SCOPE: AcpIdempotencyScope = {
  deployment: DEPLOYMENT,
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
    ['a different deployment', { deployment: 'https://other-gateway.example.com' }],
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

  it('refuses a key whose earlier attempt was left unresolved', () => {
    const store = memoryStore();
    store.claim(SCOPE, FINGERPRINT);
    store.markUnresolved(SCOPE);

    // Neither a replay (there is no answer to give) nor a fresh reservation
    // (running it again could repeat a side effect the merchant already took)
    expect(store.claim(SCOPE, FINGERPRINT)).toEqual({ kind: 'unresolved' });
    store.close();
  });

  it('keeps an unresolved record past its retention window', () => {
    let clock = Date.parse('2026-01-01T00:00:00.000Z');
    const store = memoryStore(() => clock);
    store.claim(SCOPE, FINGERPRINT);
    store.markUnresolved(SCOPE);

    // Sweeping this row would hand the next retry a clean key, which is the
    // duplicate the state exists to prevent. Only a completed row expires.
    clock += 30 * 24 * 60 * 60 * 1000;
    expect(store.claim(SCOPE, FINGERPRINT)).toEqual({ kind: 'unresolved' });
    store.close();
  });

  it('survives a reopen with an unresolved record intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-acp-idem-'));
    const path = join(dir, 'acp-idempotency.sqlite');

    const first = createAcpIdempotencyStore({ path, retentionHours: 24 });
    first.claim(SCOPE, FINGERPRINT);
    first.markUnresolved(SCOPE);
    first.close();

    const second = createAcpIdempotencyStore({ path, retentionHours: 24 });
    expect(second.claim(SCOPE, FINGERPRINT)).toEqual({ kind: 'unresolved' });
    second.close();

    rmSync(dir, { recursive: true, force: true });
  });

  it('discards a v1 database rather than carrying keys it cannot translate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-acp-v1-'));
    const path = join(dir, 'acp-idempotency.sqlite');

    // A v1 file, keyed by the old bearer-token digest, with one claim that was
    // deliberately being held.
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE acp_idempotency (
        identity_hash    TEXT NOT NULL,
        endpoint         TEXT NOT NULL,
        idempotency_key  TEXT NOT NULL,
        fingerprint      TEXT NOT NULL,
        state            TEXT NOT NULL,
        status           INTEGER,
        body_json        TEXT,
        created_at       TEXT NOT NULL,
        expires_at       TEXT NOT NULL,
        PRIMARY KEY (identity_hash, endpoint, idempotency_key)
      );
      INSERT INTO acp_idempotency VALUES
        ('old-digest', '/acp/checkout_sessions', 'idem-1', 'fp', 'unresolved',
         NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
    `);
    legacy.pragma('user_version = 1');
    legacy.close();

    const store = createAcpIdempotencyStore({ path, retentionHours: 24 });
    // The old key was a one-way digest of a credential, so nothing can be
    // carried forward; the row is gone and the scope is the new one.
    expect(store.claim(SCOPE, FINGERPRINT)).toEqual({ kind: 'reserved' });
    store.close();

    const upgraded = new Database(path, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(2);
    const columns = (upgraded.pragma('table_info(acp_idempotency)') as { name: string }[]).map(
      (column) => column.name,
    );
    upgraded.close();
    expect(columns).toContain('deployment');
    expect(columns).not.toContain('identity_hash');

    rmSync(dir, { recursive: true, force: true });
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

    // The bearer token is not part of the scope at all any more, so nothing
    // derived from it can reach the file either.
    const bytes = readFileSync(path).toString('binary');
    expect(bytes).not.toContain('acp-secret-token');
    expect(bytes).toContain(DEPLOYMENT);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('ACP operation keys', () => {
  it('is the same value every time the same operation is presented', () => {
    // What makes a retry recognisable to the merchant: the client key is the
    // same, so the derived one is too, however many attempts it takes.
    expect(operationKey(SCOPE)).toBe(operationKey({ ...SCOPE }));
  });

  it.each([
    ['another deployment', { deployment: 'https://other-gateway.example.com' }],
    ['another endpoint', { endpoint: '/acp/checkout_sessions/cs_1/complete' }],
    ['another key', { key: 'idem-2' }],
  ])('differs for %s', (_label, override) => {
    expect(operationKey({ ...SCOPE, ...override })).not.toBe(operationKey(SCOPE));
  });

  it('discloses neither the caller key nor the deployment it is scoped by', () => {
    const derived = operationKey(SCOPE);

    // It goes to the merchant, so it carries nothing back: the caller's key is
    // client-supplied, and nothing about the gateway needs to travel with it.
    expect(derived).not.toContain(SCOPE.key);
    expect(derived).not.toContain(DEPLOYMENT);
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
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
    token = 'acp-secret-token',
  ): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
    let status = 0;
    let headers: Record<string, string> = {};
    let raw = '';
    const res = {
      headersSent: false,
      writeHead(code: number, sent?: Record<string, string>) {
        status = code;
        headers = sent ?? {};
        return res;
      },
      end(chunk?: string) {
        if (chunk !== undefined) raw = chunk;
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
          authorization: `Bearer ${token}`,
          'api-version': ACP_SPEC_VERSION,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
      },
    );
    await adapter.handleHttp(req as never, res as never);
    return { status, headers, body: raw.length > 0 ? JSON.parse(raw) : undefined };
  }

  const CREATE = { line_items: [{ id: 'item_123' }], currency: 'usd', capabilities: {} };

  it('echoes the Idempotency-Key it accepted', async () => {
    const adapter = createAcpAdapter(adapterOptions());
    await adapter.start(setup(deliveredFor('createCheckoutSession')).context);

    const result = await post(adapter, 'idem-echo', CREATE);
    expect(result.headers['idempotency-key']).toBe('idem-echo');
    expect(result.headers['idempotent-replayed']).toBeUndefined();
    await adapter.stop();
  });

  it('replays the first answer for a repeat of the same request', async () => {
    const { context, execute } = setup(deliveredFor('createCheckoutSession'));
    const adapter = createAcpAdapter(adapterOptions());
    await adapter.start(context);

    const first = await post(adapter, 'idem-replay', CREATE);
    const second = await post(adapter, 'idem-replay', CREATE);

    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    // The whole point: the merchant backend was called once, not twice.
    expect(execute).toHaveBeenCalledTimes(1);
    await adapter.stop();
  });

  it('refuses a key reused for a different body, without executing again', async () => {
    const { context, execute } = setup(deliveredFor('createCheckoutSession'));
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
  it('keeps a claim across a bearer-token rotation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-acp-rotate-'));
    const path = join(dir, 'idem.sqlite');
    const idempotency = { path, retentionHours: 24 };

    // Two adapters over one database, same deployment, different credentials:
    // the operator rotated the token between the ambiguous attempt and the retry.
    const before = createAcpAdapter(adapterOptions({ token: 'old-token', idempotency }));
    await before.start(setup(new Error('backend exploded')).context);
    const ambiguous = await post(before, 'idem-rotate', CREATE, 'old-token');
    await before.stop();

    const after = createAcpAdapter(adapterOptions({ token: 'new-token', idempotency }));
    await after.start(setup(deliveredFor('createCheckoutSession')).context);
    const retry = await post(after, 'idem-rotate', CREATE, 'new-token');
    await after.stop();

    expect(ambiguous.status).toBe(500);
    // A credential must not be able to free a claim. Scoped by a digest of the
    // token, the new one found no row, reserved afresh and re-ran the operation.
    expect(retry.status).toBe(409);
    expect((retry.body as { code?: string }).code).toBe('idempotency_unresolved');

    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the key claimed when a 5xx leaves the merchant outcome unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-acp-adapter-'));
    const path = join(dir, 'idem.sqlite');
    const adapter = createAcpAdapter(adapterOptions({ idempotency: { path, retentionHours: 24 } }));
    await adapter.start(setup(new Error('backend exploded')).context);

    // A bare Error out of the pipeline says nothing about whether the merchant
    // ran, so it is ambiguous and the second attempt must not re-run it.
    const first = await post(adapter, 'idem-5xx', CREATE);
    const second = await post(adapter, 'idem-5xx', CREATE);

    expect(first.status).toBe(500);
    expect(second.status).toBe(409);
    expect((second.body as { code?: string }).code).toBe('idempotency_unresolved');
    expect(second.headers['idempotent-replayed']).toBeUndefined();

    // The claim survives as a row an operator can find, rather than vanishing
    // and handing the next retry a clean key.
    await adapter.stop();
    const db = new Database(path, { readonly: true });
    const rows = db.prepare('SELECT state FROM acp_idempotency').all() as { state: string }[];
    db.close();
    expect(rows.map((row) => row.state)).toEqual(['unresolved']);

    rmSync(dir, { recursive: true, force: true });
  });
});
