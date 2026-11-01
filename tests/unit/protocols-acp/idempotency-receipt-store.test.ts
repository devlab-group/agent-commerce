/**
 * Run ACP checkout idempotency cases against the shared receipt store and the
 * legacy file fallback. Separately check the receipt store's startup recovery
 * hook, retention under the adapter's clock and ownership of supplied stores.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clock, Logger, ReceiptStore } from '../../../src/core';
import { CommerceError } from '../../../src/core';
import { type AcpAdapterOptions, createAcpAdapter } from '../../../src/protocols/acp/adapter';
import { requestFingerprint } from '../../../src/protocols/acp/idempotency/fingerprint';
import { createSqliteReceiptStore, type SqliteReceiptStore } from '../../../src/storage/receipts';
import { createFakeStore } from '../gateway/helpers';
import {
  adapterOptions,
  delivered,
  deliveredFor,
  NOOP_LOGGER,
  postCheckout,
  setup,
} from './fixtures';

const CREATE = { line_items: [{ id: 'item_123' }], currency: 'usd', capabilities: {} };
const DEPLOYMENT = 'https://merchant.example.com';
const ENDPOINT = '/acp/checkout_sessions';
const START = Date.parse('2026-01-01T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;

let dir: string;
let stores: SqliteReceiptStore[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oac-acp-store-'));
  stores = [];
});

afterEach(async () => {
  for (const store of stores) await store.close();
  rmSync(dir, { recursive: true, force: true });
});

// The store sweeps expired claims by its own clock, so it shares the fixture
// clock, which the adapter reads through `context.clock`
function openStore(clock: Clock = movableClock().clock): SqliteReceiptStore {
  const store = createSqliteReceiptStore({ path: join(dir, 'receipts.sqlite'), clock });
  stores.push(store);
  return store;
}

function movableClock(): { clock: Clock; advance(ms: number): void } {
  let at = START;
  return {
    clock: {
      now: () => new Date(at),
      nowIso: () => new Date(at).toISOString(),
      monotonicMs: () => at,
    },
    advance(ms) {
      at += ms;
    },
  };
}

function loggerWith(warn: Logger['warn']): Logger {
  return { ...NOOP_LOGGER, warn };
}

function rowStates(): string[] {
  const db = new Database(join(dir, 'receipts.sqlite'), { readonly: true });
  try {
    const rows = db.prepare('SELECT state FROM idempotency_keys ORDER BY idempotency_key').all();
    return (rows as { state: string }[]).map((row) => row.state);
  } finally {
    db.close();
  }
}

type BackendName = 'file store' | 'receipt store';

// Use the same adapter settings for both backends; the receipt-store variant
// omits the deprecated idempotency.path
function optionsFor(backend: BackendName, merchantIdempotent = false): Partial<AcpAdapterOptions> {
  if (backend === 'file store') {
    return {
      idempotency: { path: join(dir, 'acp.sqlite'), retentionHours: 24, merchantIdempotent },
    };
  }
  return { store: openStore(), idempotency: { retentionHours: 24, merchantIdempotent } };
}

describe.each<BackendName>(['file store', 'receipt store'])(
  'ACP idempotency on the %s',
  (backend) => {
    it('replays the first answer and runs the merchant once', async () => {
      const { context, execute } = setup(deliveredFor('createCheckoutSession'));
      const adapter = createAcpAdapter(adapterOptions(optionsFor(backend)));
      await adapter.start(context);

      const first = await postCheckout(adapter, 'idem-replay', CREATE);
      const second = await postCheckout(adapter, 'idem-replay', CREATE);

      expect(first.status).toBe(201);
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      expect(second.status).toBe(201);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body).toEqual(first.body);
      expect(execute).toHaveBeenCalledTimes(1);
      await adapter.stop();
    });

    it('answers 409 in flight to a retry that arrives while the first still runs', async () => {
      const { context, execute } = setup(deliveredFor('createCheckoutSession'));
      let started: () => void = () => {};
      const running = new Promise<void>((resolve) => {
        started = resolve;
      });
      let finish: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      execute.mockImplementationOnce(async () => {
        started();
        await gate;
        return deliveredFor('createCheckoutSession');
      });
      const adapter = createAcpAdapter(adapterOptions(optionsFor(backend)));
      await adapter.start(context);

      const first = postCheckout(adapter, 'idem-flight', CREATE);
      await running;
      const duplicate = await postCheckout(adapter, 'idem-flight', CREATE);
      finish();
      const settled = await first;

      expect(duplicate.status).toBe(409);
      expect((duplicate.body as { code?: string }).code).toBe('idempotency_in_flight');
      expect(duplicate.headers['retry-after']).toBeDefined();
      expect(settled.status).toBe(201);
      expect(execute).toHaveBeenCalledTimes(1);
      await adapter.stop();
    });

    it('refuses a key reused for another body with 422', async () => {
      const { context, execute } = setup(deliveredFor('createCheckoutSession'));
      const adapter = createAcpAdapter(adapterOptions(optionsFor(backend)));
      await adapter.start(context);

      await postCheckout(adapter, 'idem-conflict', CREATE);
      const conflict = await postCheckout(adapter, 'idem-conflict', { ...CREATE, currency: 'eur' });

      expect(conflict.status).toBe(422);
      expect((conflict.body as { code?: string }).code).toBe('idempotency_conflict');
      expect(execute).toHaveBeenCalledTimes(1);
      await adapter.stop();
    });

    it('keeps the claim unresolved when the merchant outcome is unknown', async () => {
      const { context, execute } = setup(new Error('backend exploded'));
      const adapter = createAcpAdapter(adapterOptions(optionsFor(backend)));
      await adapter.start(context);

      const first = await postCheckout(adapter, 'idem-unknown', CREATE);
      const retry = await postCheckout(adapter, 'idem-unknown', CREATE);

      expect(first.status).toBe(500);
      expect(retry.status).toBe(409);
      expect((retry.body as { code?: string }).code).toBe('idempotency_unresolved');
      expect(execute).toHaveBeenCalledTimes(1);
      await adapter.stop();
    });

    it('keeps a claim unresolved when the adapter faults after the pipeline ran', async () => {
      const { context, execute } = setup(new CommerceError('BACKEND_TIMEOUT', 'timed out'));
      const adapter = createAcpAdapter(adapterOptions(optionsFor(backend)));
      // A throwing log sink stands in for any fault after the pipeline was called
      await adapter.start({
        ...context,
        logger: loggerWith(() => {
          throw new Error('log sink down');
        }),
      });

      const failed = await postCheckout(adapter, 'idem-fault', CREATE);
      const retry = await postCheckout(adapter, 'idem-fault', CREATE);

      expect(failed.status).toBe(500);
      expect(retry.status).toBe(409);
      expect((retry.body as { code?: string }).code).toBe('idempotency_unresolved');
      expect(execute).toHaveBeenCalledTimes(1);
      await adapter.stop();
    });

    // ACP relays both as 503, and neither reached a merchant that could have acted
    it.each([
      ['the gateway shed load', new CommerceError('GATEWAY_BUSY', 'load shed')],
      [
        'the merchant rate limited the call',
        new CommerceError('BACKEND_ERROR', 'slow down', { details: { status: 429 } }),
      ],
    ])('frees the key so a retry runs when %s', async (_label, thrown) => {
      const { context, execute } = setup(deliveredFor('createCheckoutSession'));
      execute.mockRejectedValueOnce(thrown);
      const adapter = createAcpAdapter(adapterOptions(optionsFor(backend)));
      await adapter.start(context);

      const refused = await postCheckout(adapter, 'idem-free', CREATE);
      const retry = await postCheckout(adapter, 'idem-free', CREATE);

      expect(refused.status).toBe(503);
      expect(retry.status).toBe(201);
      expect(retry.headers['idempotent-replayed']).toBeUndefined();
      expect(execute).toHaveBeenCalledTimes(2);
      await adapter.stop();
    });

    it('replays a merchant refusal as an outcome', async () => {
      const { context, execute } = setup(
        new CommerceError('BACKEND_ERROR', 'merchant refused', { details: { status: 409 } }),
      );
      const adapter = createAcpAdapter(adapterOptions(optionsFor(backend)));
      await adapter.start(context);

      const refused = await postCheckout(adapter, 'idem-refused', CREATE);
      const retry = await postCheckout(adapter, 'idem-refused', CREATE);

      expect(refused.status).toBe(409);
      expect(retry.status).toBe(409);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(execute).toHaveBeenCalledTimes(1);
      await adapter.stop();
    });

    it('keeps the key claimed after a non-ACP merchant answer', async () => {
      const { context, execute } = setup(delivered({ ok: true, order: 'ord_1' }, 201));
      const adapter = createAcpAdapter(adapterOptions(optionsFor(backend)));
      await adapter.start(context);

      const refused = await postCheckout(adapter, 'idem-non-acp', CREATE);
      const retry = await postCheckout(adapter, 'idem-non-acp', CREATE);

      expect(refused.status).toBe(500);
      expect(retry.status).toBe(409);
      expect((retry.body as { code?: string }).code).toBe('idempotency_unresolved');
      expect(execute).toHaveBeenCalledTimes(1);
      await adapter.stop();
    });

    it('frees the key after an unknown outcome when the merchant deduplicates', async () => {
      const { context, execute } = setup(deliveredFor('createCheckoutSession'));
      execute.mockRejectedValueOnce(new Error('backend exploded'));
      const adapter = createAcpAdapter(adapterOptions(optionsFor(backend, true)));
      await adapter.start(context);

      const first = await postCheckout(adapter, 'idem-dedupe', CREATE);
      const retry = await postCheckout(adapter, 'idem-dedupe', CREATE);

      expect(first.status).toBe(500);
      expect(retry.status).toBe(201);
      expect(execute).toHaveBeenCalledTimes(2);
      await adapter.stop();
    });
  },
);

describe('ACP idempotency on the receipt store only', () => {
  it('hands the store the claim, the fingerprint and an expiry a retention window ahead', async () => {
    const updateIdempotencyKey = vi.fn<NonNullable<ReceiptStore['updateIdempotencyKey']>>(
      async () => {},
    );
    const claimIdempotencyKey = vi.fn(async () => ({ kind: 'reserved' as const }));
    const store: ReceiptStore = {
      ...createFakeStore(),
      claimIdempotencyKey,
      updateIdempotencyKey,
      recoverIdempotencyKeys: async () => 0,
    };
    const { context } = setup(deliveredFor('createCheckoutSession'));
    const adapter = createAcpAdapter(
      adapterOptions({ store, idempotency: { retentionHours: 36 } }),
    );
    await adapter.start(context);

    await postCheckout(adapter, 'idem-map', CREATE);

    expect(claimIdempotencyKey).toHaveBeenCalledWith(
      { deployment: DEPLOYMENT, endpoint: ENDPOINT, key: 'idem-map' },
      requestFingerprint(CREATE),
      // The fixture clock stands at 2026-01-01T00:00:00Z
      '2026-01-02T12:00:00.000Z',
    );
    expect(updateIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(updateIdempotencyKey).toHaveBeenCalledWith(
      { deployment: DEPLOYMENT, endpoint: ENDPOINT, key: 'idem-map' },
      { kind: 'completed', status: 201, body: expect.objectContaining({ id: expect.any(String) }) },
    );
    await adapter.stop();
  });

  it('sends unresolved and released updates for the outcomes that call for them', async () => {
    const updateIdempotencyKey = vi.fn<NonNullable<ReceiptStore['updateIdempotencyKey']>>(
      async () => {},
    );
    const store: ReceiptStore = {
      ...createFakeStore(),
      claimIdempotencyKey: async () => ({ kind: 'reserved' as const }),
      updateIdempotencyKey,
      recoverIdempotencyKeys: async () => 0,
    };
    const { context, execute } = setup(new Error('backend exploded'));
    execute.mockRejectedValueOnce(new CommerceError('GATEWAY_BUSY', 'load shed'));
    const adapter = createAcpAdapter(
      adapterOptions({ store, idempotency: { retentionHours: 24 } }),
    );
    await adapter.start(context);

    await postCheckout(adapter, 'idem-released', CREATE);
    await postCheckout(adapter, 'idem-unresolved', CREATE);

    expect(updateIdempotencyKey.mock.calls.map((call) => call[1])).toEqual([
      { kind: 'released' },
      { kind: 'unresolved' },
    ]);
    await adapter.stop();
  });

  it('expires a completed answer after the retention window of the adapter clock', async () => {
    const time = movableClock();
    const store = openStore(time.clock);
    const { context, execute } = setup(deliveredFor('createCheckoutSession'));
    const adapter = createAcpAdapter(
      adapterOptions({ store, idempotency: { retentionHours: 24 } }),
    );
    await adapter.start({ ...context, clock: time.clock });

    await postCheckout(adapter, 'idem-retain', CREATE);
    time.advance(23 * HOUR);
    const within = await postCheckout(adapter, 'idem-retain', CREATE);
    time.advance(2 * HOUR);
    const after = await postCheckout(adapter, 'idem-retain', CREATE);

    expect(within.headers['idempotent-replayed']).toBe('true');
    expect(after.status).toBe(201);
    expect(after.headers['idempotent-replayed']).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
    await adapter.stop();
  });

  it('replays a completed answer after the adapter restarts on the same store', async () => {
    const store = openStore();
    const { context, execute } = setup(deliveredFor('createCheckoutSession'));
    const options = adapterOptions({ store, idempotency: { retentionHours: 24 } });

    const before = createAcpAdapter(options);
    await before.start(context);
    await postCheckout(before, 'idem-restart', CREATE);
    await before.stop();

    const after = createAcpAdapter(options);
    await after.start(context);
    const retry = await postCheckout(after, 'idem-restart', CREATE);
    await after.stop();

    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('leaves a shared store open when the adapter stops', async () => {
    const store = openStore();
    const { context } = setup(deliveredFor('createCheckoutSession'));
    const adapter = createAcpAdapter(
      adapterOptions({ store, idempotency: { retentionHours: 24 } }),
    );
    await adapter.start(context);
    await postCheckout(adapter, 'idem-stop', CREATE);
    await adapter.stop();

    const scope = { deployment: DEPLOYMENT, endpoint: ENDPOINT, key: 'idem-after-stop' };
    await expect(
      store.claimIdempotencyKey(scope, 'fp', new Date(START + HOUR).toISOString()),
    ).resolves.toEqual({ kind: 'reserved' });
    await expect(store.summary({ orphanHoldMinAgeMs: 0 })).resolves.toBeDefined();
  });

  describe('a claim that throws', () => {
    it.each([
      ['rejects', async () => Promise.reject(new CommerceError('STORAGE_ERROR', 'disk full'))],
      [
        'throws synchronously',
        () => {
          throw new Error('disk full');
        },
      ],
    ])('answers 500 and runs no checkout when the store %s', async (_label, claim) => {
      const store: ReceiptStore = {
        ...createFakeStore(),
        claimIdempotencyKey: claim as never,
        updateIdempotencyKey: vi.fn(async () => {}),
        recoverIdempotencyKeys: async () => 0,
      };
      const { context, execute } = setup(deliveredFor('createCheckoutSession'));
      const adapter = createAcpAdapter(
        adapterOptions({ store, idempotency: { retentionHours: 24 } }),
      );
      await adapter.start(context);

      const result = await postCheckout(adapter, 'idem-claim-fails', CREATE);

      expect(result.status).toBe(500);
      expect(result.body).toMatchObject({ type: 'processing_error', code: 'internal_error' });
      expect(JSON.stringify(result.body)).not.toContain('disk full');
      expect(execute).not.toHaveBeenCalled();
      await adapter.stop();
    });
  });
});

describe('ACP idempotency recovery on the receipt store', () => {
  const scope = { deployment: DEPLOYMENT, endpoint: ENDPOINT, key: 'idem-orphan' };
  const expiresAt = new Date(START + 24 * HOUR).toISOString();

  // A claim an earlier process left in flight, as it sits on disk after a crash
  async function leaveOrphan(): Promise<void> {
    const earlier = openStore();
    await earlier.claimIdempotencyKey(scope, requestFingerprint(CREATE), expiresAt);
    await earlier.close();
    stores = [];
  }

  it('does not touch the claim when the store opens', async () => {
    await leaveOrphan();
    openStore();
    expect(rowStates()).toEqual(['in_flight']);
  });

  it('marks the claim unresolved when the adapter starts, and logs it', async () => {
    await leaveOrphan();
    const store = openStore();
    const warn = vi.fn();
    const { context, execute } = setup(deliveredFor('createCheckoutSession'));
    const adapter = createAcpAdapter(
      adapterOptions({ store, idempotency: { retentionHours: 24 } }),
    );

    await adapter.start({ ...context, logger: loggerWith(warn) });

    expect(rowStates()).toEqual(['unresolved']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ unresolved: 1 }, expect.stringContaining('in flight'));
    const retry = await postCheckout(adapter, 'idem-orphan', CREATE);
    expect(retry.status).toBe(409);
    expect((retry.body as { code?: string }).code).toBe('idempotency_unresolved');
    expect(execute).not.toHaveBeenCalled();
    await adapter.stop();
  });

  it('deletes the claim at start when the merchant deduplicates, so a retry runs', async () => {
    await leaveOrphan();
    const store = openStore();
    const warn = vi.fn();
    const { context, execute } = setup(deliveredFor('createCheckoutSession'));
    const adapter = createAcpAdapter(
      adapterOptions({ store, idempotency: { retentionHours: 24, merchantIdempotent: true } }),
    );

    await adapter.start({ ...context, logger: loggerWith(warn) });

    expect(rowStates()).toEqual([]);
    expect(warn).toHaveBeenCalledWith({ released: 1 }, expect.stringContaining('freed claims'));
    const retry = await postCheckout(adapter, 'idem-orphan', CREATE);
    expect(retry.status).toBe(201);
    expect(execute).toHaveBeenCalledTimes(1);
    await adapter.stop();
  });

  it('stays silent when nothing was left in flight', async () => {
    const store = openStore();
    const warn = vi.fn();
    const { context } = setup(deliveredFor('createCheckoutSession'));
    const adapter = createAcpAdapter(
      adapterOptions({ store, idempotency: { retentionHours: 24 } }),
    );

    await adapter.start({ ...context, logger: loggerWith(warn) });

    expect(warn).not.toHaveBeenCalled();
    await adapter.stop();
  });

  it('fails the start when recovery fails, so no claim is served on an unknown state', async () => {
    const store: ReceiptStore = {
      ...createFakeStore(),
      claimIdempotencyKey: async () => ({ kind: 'reserved' as const }),
      updateIdempotencyKey: async () => {},
      recoverIdempotencyKeys: async () => {
        throw new CommerceError('STORAGE_ERROR', 'recovery failed');
      },
    };
    const { context } = setup(deliveredFor('createCheckoutSession'));
    const adapter = createAcpAdapter(
      adapterOptions({ store, idempotency: { retentionHours: 24 } }),
    );

    await expect(adapter.start(context)).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect((await adapter.health()).status).toBe('fail');
  });
});

describe('choosing the idempotency backend', () => {
  it('throws CONFIG_INVALID naming the setting when there is no store and no path', async () => {
    const adapter = createAcpAdapter(adapterOptions({ idempotency: { retentionHours: 24 } }));
    const { context } = setup();

    const started = adapter.start(context);

    await expect(started).rejects.toBeInstanceOf(CommerceError);
    await expect(started).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringContaining('protocols.acp.idempotency.path'),
    });
    expect((await adapter.health()).status).toBe('fail');
  });

  it.each([
    ['no idempotency methods', {}],
    [
      'only part of the idempotency methods',
      { claimIdempotencyKey: async () => ({ kind: 'reserved' as const }) },
    ],
  ])('falls back to the file when the store has %s', async (_label, extra) => {
    const store: ReceiptStore = { ...createFakeStore(), ...extra };
    const { context, execute } = setup(deliveredFor('createCheckoutSession'));
    const path = join(dir, 'acp.sqlite');
    const adapter = createAcpAdapter(
      adapterOptions({ store, idempotency: { path, retentionHours: 24 } }),
    );
    await adapter.start(context);

    await postCheckout(adapter, 'idem-file', CREATE);
    const retry = await postCheckout(adapter, 'idem-file', CREATE);
    await adapter.stop();

    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(execute).toHaveBeenCalledTimes(1);
    const db = new Database(path, { readonly: true });
    const rows = db.prepare('SELECT state FROM acp_idempotency').all();
    db.close();
    expect(rows).toHaveLength(1);
  });

  it('requires the path when the store has only part of the methods', async () => {
    const store: ReceiptStore = {
      ...createFakeStore(),
      claimIdempotencyKey: async () => ({ kind: 'reserved' as const }),
    };
    const adapter = createAcpAdapter(
      adapterOptions({ store, idempotency: { retentionHours: 24 } }),
    );
    const { context } = setup();

    await expect(adapter.start(context)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('prefers the receipt store over a configured path and never creates the file', async () => {
    const store = openStore();
    const path = join(dir, 'unused-acp.sqlite');
    const { context } = setup(deliveredFor('createCheckoutSession'));
    const adapter = createAcpAdapter(
      adapterOptions({ store, idempotency: { path, retentionHours: 24 } }),
    );
    await adapter.start(context);

    await postCheckout(adapter, 'idem-prefer', CREATE);
    await adapter.stop();

    expect(rowStates()).toEqual(['completed']);
    expect(() => new Database(path, { readonly: true, fileMustExist: true })).toThrow();
  });
});
