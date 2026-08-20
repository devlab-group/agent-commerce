import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReceiptStore } from '../../../src/core/index.js';
import { createSqliteReceiptStore } from '../../../src/storage/receipts/index.js';
import { containsSecretKey, redact } from '../../../src/storage/receipts/redact.js';
import { createFakeClock, createFakeIds, makeEvent, makeReceipt } from './helpers.js';

/**
 * Store NO secrets (docs/contracts.md): a private key, an Authorization
 * header or a raw payment proof must never be persisted, even if a caller
 * accidentally puts one in `metadata` / `data`.
 *
 * Chosen strategy: STRIP (redact), not reject. `appendEvent` must never throw
 * into the caller's flow, so rejecting would violate that contract for
 * events; stripping keeps behaviour identical (and non-throwing) for both
 * receipts and events. Redaction is recursive and key-pattern based — see
 * src/redact.ts.
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

  it('containsSecretKey detects secret-shaped keys', () => {
    expect(containsSecretKey({ privateKey: 'x' })).toBe(true);
    expect(containsSecretKey({ nested: { apiKey: 'x' } })).toBe(true);
    expect(containsSecretKey({ safe: 'value' })).toBe(false);
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

  it('containsSecretKey detects a signature/signedMessage key', () => {
    expect(containsSecretKey({ signature: 'x' })).toBe(true);
    expect(containsSecretKey({ nested: { signedMessage: 'x' } })).toBe(true);
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

  it('never persists the literal secret value anywhere in the underlying row', async () => {
    const secretValue = 'THIS_MUST_NEVER_BE_STORED_VERBATIM';
    await store.saveReceipt(makeReceipt({ id: 'r_scan', metadata: { password: secretValue } }));
    await store.appendEvent(makeEvent({ id: 'e_scan', data: { mnemonic: secretValue } }));

    const receipts = await store.listReceipts();
    const events = await store.listEvents();
    expect(JSON.stringify(receipts)).not.toContain(secretValue);
    expect(JSON.stringify(events)).not.toContain(secretValue);
  });
});

describe('bearer-token-shaped keys', () => {
  // Nothing writes these today, which is precisely the situation a second
  // line of defence exists for — and the ledger they would land in is a file
  // on disk, kept owner-only because its contents are worth protecting.
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
    expect(redacted['outer']?.[key]).not.toBe('value-that-must-not-persist');
    expect(containsSecretKey({ [key]: 'x' })).toBe(true);
  });

  it('control: ordinary ledger fields are not redacted — the pattern must not eat real data', () => {
    const clean = {
      amount: '0.01',
      payer: '0xabc',
      payTo: '0xdef',
      requestId: 'req_1',
      resourceId: 'market_report',
      network: 'base-sepolia',
      asset: '0x123',
      status: 'settled',
      txHash: '0xfeed',
      durationMs: 12,
    };
    expect(redact(clean)).toEqual(clean);
    expect(containsSecretKey(clean)).toBe(false);
  });
});
