import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTHORIZATION_INPUT_FIELD,
  PAYMENT_INPUT_FIELD,
  type ReceiptStore,
} from '../../../src/core';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import { isSecretKey, redact } from '../../../src/storage/receipts/redact';
import { createConformanceClock, isoAt } from '../../../src/testing/conformance/support';
import { dumpTables } from '../../fixtures/sqlite-dump';
import {
  assemblePresentation,
  CHECKOUT_ISSUER,
  createParties,
  MANDATE_ISSUER,
  mintMandateParts,
  sha256Base64url,
  signCheckoutJwt,
} from '../authorization-ap2/fixtures';
import { createFakeClock, createFakeIds, makeEvent, makeReceipt } from './helpers';

/**
 * Store no secrets (docs/contracts.md): a private key, an Authorization header
 * or a raw payment proof is never persisted, even when a caller puts one in
 * `metadata` or `data`. The store redacts rather than rejects, because
 * `appendEvent` must not throw into the caller's flow. See
 * src/storage/receipts/redact.ts.
 */
describe('no-secrets guarantee', () => {
  let store: ReceiptStore;

  beforeEach(async () => {
    store = createSqliteReceiptStore({
      path: ':memory:',
      clock: createFakeClock(),
      ids: createFakeIds(),
    });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
  });

  it('redact() strips a private-key-shaped field recursively', () => {
    const dirty = {
      note: 'fine',
      privateKey: '0xdeadbeef',
      nested: { authorization: 'Bearer secret-token', ok: 'value' },
    };
    const clean = redact(dirty);
    expect(clean.privateKey).toBe('[REDACTED]');
    expect((clean.nested as Record<string, unknown>).authorization).toBe('[REDACTED]');
    expect((clean.nested as Record<string, unknown>).ok).toBe('value');
    expect(clean.note).toBe('fine');
  });

  it('isSecretKey detects secret-shaped keys', () => {
    expect(isSecretKey('privateKey')).toBe(true);
    expect(isSecretKey('apiKey')).toBe(true);
    expect(isSecretKey('safe')).toBe(false);
  });

  it('redact() strips a signature-shaped field (e.g. an EIP-712/EIP-3009 signature)', () => {
    const dirty = {
      signature: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1b',
      nested: { signedMessage: 'raw signed payload', signed_message: 'also raw', ok: 'value' },
    };
    const clean = redact(dirty);
    expect(clean.signature).toBe('[REDACTED]');
    expect((clean.nested as Record<string, unknown>).signedMessage).toBe('[REDACTED]');
    expect((clean.nested as Record<string, unknown>).signed_message).toBe('[REDACTED]');
    expect((clean.nested as Record<string, unknown>).ok).toBe('value');
  });

  it('isSecretKey detects a signature/signedMessage key', () => {
    expect(isSecretKey('signature')).toBe(true);
    expect(isSecretKey('signedMessage')).toBe(true);
  });

  it('strips a privateKey-ish field from receipt metadata before it reaches the database', async () => {
    const receipt = makeReceipt({
      id: 'r_secret',
      metadata: { privateKey: '0xSHOULD_NOT_PERSIST', label: 'ok' },
    });
    await store.saveReceipt(receipt);

    const fetched = await store.getReceipt('r_secret');
    expect(fetched?.metadata?.privateKey).toBe('[REDACTED]');
    expect(fetched?.metadata?.label).toBe('ok');
    expect(JSON.stringify(fetched)).not.toContain('0xSHOULD_NOT_PERSIST');
  });

  it('strips a secret-shaped field from receipt.authorization.metadata', async () => {
    const receipt = makeReceipt({
      id: 'r_auth',
      authorization: {
        method: 'ap2',
        reference: 'sha256:abc',
        metadata: { mandateToken: 'eyJ...', checkoutId: 'checkout-1' },
      },
    });
    await store.saveReceipt(receipt);

    const fetched = await store.getReceipt('r_auth');
    expect(fetched?.authorization?.metadata?.['mandateToken']).toBe('[REDACTED]');
    expect(fetched?.authorization?.metadata?.['checkoutId']).toBe('checkout-1');
    expect(fetched?.authorization?.reference).toBe('sha256:abc');
  });

  it('strips a raw payment proof / Authorization header from receipt.payment.metadata', async () => {
    const receipt = makeReceipt({
      id: 'r_secret_payment',
      payment: {
        status: 'settled',
        provider: 'x402',
        amount: '0.01',
        currency: 'USDC',
        metadata: {
          Authorization: 'Bearer super-secret',
          paymentProof: 'raw-x402-proof-bytes',
        },
      },
    });
    await store.saveReceipt(receipt);

    const fetched = await store.getReceipt('r_secret_payment');
    const meta = fetched?.payment?.metadata as Record<string, unknown>;
    expect(meta.Authorization).toBe('[REDACTED]');
    expect(meta.paymentProof).toBe('[REDACTED]');
  });

  it('strips a raw EIP-3009/x402 signature from receipt.payment.metadata', async () => {
    const receipt = makeReceipt({
      id: 'r_secret_signature',
      payment: {
        status: 'settled',
        provider: 'x402',
        amount: '0.01',
        currency: 'USDC',
        metadata: {
          signature: '0xSHOULD_NOT_PERSIST_SIGNATURE_BYTES',
          settlementRef: 'ok-to-keep',
        },
      },
    });
    await store.saveReceipt(receipt);

    const fetched = await store.getReceipt('r_secret_signature');
    const meta = fetched?.payment?.metadata as Record<string, unknown>;
    expect(meta.signature).toBe('[REDACTED]');
    expect(meta.settlementRef).toBe('ok-to-keep');
    expect(JSON.stringify(fetched)).not.toContain('0xSHOULD_NOT_PERSIST_SIGNATURE_BYTES');
  });

  it('strips a privateKey-ish field from event data before it reaches the database', async () => {
    const event = makeEvent({
      id: 'e_secret',
      data: { privateKey: '0xSHOULD_NOT_PERSIST', ok: true },
    });
    await store.appendEvent(event);

    const [fetched] = await store.listEvents({ requestId: event.requestId });
    expect(fetched?.data?.privateKey).toBe('[REDACTED]');
    expect(fetched?.data?.ok).toBe(true);
  });

  // Reads the database file, not the store's read path, so redacting only on
  // the way out would fail here
  it('never writes the literal secret value to the database file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-no-secrets-'));
    const path = join(dir, 'receipts.sqlite');
    const secretValue = 'THIS_MUST_NEVER_BE_STORED_VERBATIM';
    const visibleValue = 'VISIBLE_LEDGER_VALUE';
    try {
      const fileStore = createSqliteReceiptStore({ path });
      await fileStore.saveReceipt(
        makeReceipt({
          id: 'r_scan',
          metadata: { password: secretValue, label: visibleValue },
          payment: {
            status: 'settled',
            provider: 'x402',
            amount: '0.01',
            currency: 'USDC',
            metadata: { signature: secretValue },
          },
          authorization: {
            method: 'ap2',
            reference: 'sha256:abc',
            metadata: { mandateToken: secretValue },
          },
        }),
      );
      await fileStore.appendEvent(
        makeEvent({ id: 'e_scan', data: { mnemonic: secretValue, label: visibleValue } }),
      );
      await fileStore.close();

      const onDisk = [path, `${path}-wal`, `${path}-shm`]
        .filter((file) => existsSync(file))
        .map((file) => readFileSync(file).toString('latin1'))
        .join('');
      // Control: the rows reached the file
      expect(onDisk).toContain(visibleValue);
      expect(onDisk).not.toContain(secretValue);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('redact() strips secret-shaped fields inside arrays', () => {
    const dirty = { attempts: [{ signature: '0xsig', nonce: '1' }, 'plain'] };
    expect(redact(dirty)).toEqual({ attempts: [{ signature: '[REDACTED]', nonce: '1' }, 'plain'] });
  });
});

describe('bearer-token-shaped keys', () => {
  // A second line of defense: nothing writes these keys, but the redactor
  // must still catch one
  it.each([
    'token',
    'bearerToken',
    'adminToken',
    'authToken',
    'credential',
    'cookie',
    'sessionId',
    'jwt',
  ])('redacts a "%s" key at any depth', (key) => {
    const redacted = redact({ outer: { [key]: 'value-that-must-not-persist' } }) as Record<
      string,
      Record<string, unknown>
    >;
    expect(redacted['outer']?.[key]).toBe('[REDACTED]');
    expect(isSecretKey(key)).toBe(true);
  });

  it('control: ordinary ledger fields are not redacted; the pattern must not eat real data', () => {
    const clean = {
      amount: '0.01',
      payer: '0xabc',
      payTo: '0xdef',
      requestId: 'req_1',
      resourceId: 'market_report',
      network: 'eip155:31337',
      asset: '0x123',
      status: 'settled',
      txHash: '0xfeed',
      durationMs: 12,
    };
    expect(redact(clean)).toEqual(clean);
  });
});

// Guard against persisting AP2 presentations in reserved task-input fields
// or checkout JWTs in hold metadata
describe('2.6.0 records hold no AP2 presentation', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'receipt-store-presentation-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes none of the presentation, its parts or the payment proof to any table', async () => {
    const parties = await createParties();
    const checkoutJwt = await signCheckoutJwt(parties.checkoutSigner);
    const parts = await mintMandateParts(parties.mandateSigner, checkoutJwt);
    const presentation = assemblePresentation(parts.signedToken, [
      parts.mandateDisclosure,
      parts.checkoutDisclosure,
    ]);
    const proof = 'payment-proof-that-must-not-persist';
    const path = join(dir, 'receipts.sqlite');
    const sqlite = createSqliteReceiptStore({
      path,
      clock: createFakeClock(),
      ids: createFakeIds(),
    });
    await sqlite.init();
    try {
      await sqlite.reserveAuthorizationHold({
        method: 'ap2',
        reference: `sha256:${await sha256Base64url(parts.signedToken)}`,
        bindingReference: 'checkout_01KTEST',
        resourceId: 'market_report',
        requestId: 'req_1',
        // A secret-shaped key is redacted like any other metadata
        metadata: { mandateIssuer: MANDATE_ISSUER, checkoutIssuer: CHECKOUT_ISSUER, checkoutJwt },
      });
      await sqlite.putPendingTask(
        {
          id: 'a2a_task_1',
          protocol: 'a2a',
          resourceId: 'market_report',
          input: {
            symbol: 'ETH',
            [AUTHORIZATION_INPUT_FIELD]: { method: 'ap2', presentation },
            [PAYMENT_INPUT_FIELD]: proof,
          },
          adapterData: { contextId: 'ctx_1', network: 'eip155:8453' },
          expiresAt: '2026-01-01T00:10:00.000Z',
        },
        { maxTasks: 10 },
      );
      expect((await sqlite.getPendingTask('a2a_task_1'))?.input).toEqual({ symbol: 'ETH' });
    } finally {
      await sqlite.close();
    }

    const everything = JSON.stringify(dumpTables(path));
    for (const secret of [
      presentation,
      parts.signedToken,
      parts.mandateDisclosure,
      parts.checkoutDisclosure,
      checkoutJwt,
      proof,
    ]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).toContain(MANDATE_ISSUER);
  });

  // The next write must remove expired tasks and their unredacted input
  it('deletes an expired task when the next one is stored', async () => {
    const path = join(dir, 'receipts.sqlite');
    const clock = createConformanceClock();
    const sqlite = createSqliteReceiptStore({ path, clock });
    await sqlite.init();
    const task = (id: string, symbol: string, expiresAt: string) => ({
      id,
      protocol: 'a2a' as const,
      resourceId: 'market_report',
      input: { symbol },
      expiresAt,
    });
    try {
      await sqlite.putPendingTask(task('a2a_task_1', 'EXPIRED-INPUT', isoAt(60_000)), {
        maxTasks: 10,
      });
      clock.advance(120_000);
      await sqlite.putPendingTask(task('a2a_task_2', 'ETH', isoAt(600_000)), { maxTasks: 10 });
    } finally {
      await sqlite.close();
    }
    const tasks = dumpTables(path).pending_tasks as { id: string }[];
    expect(tasks.map((t) => t.id)).toEqual(['a2a_task_2']);
    expect(JSON.stringify(dumpTables(path))).not.toContain('EXPIRED-INPUT');
  });
});
