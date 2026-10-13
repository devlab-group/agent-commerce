import { describe, expect, it } from 'vitest';
import { isCommerceError } from '../../../src/core';
import { importOptionalPeer } from '../../../src/gateway/optional-peer';

// A specifier no install provides, so Node raises the real ERR_MODULE_NOT_FOUND
const MISSING: string = 'agent-commerce-no-such-peer';

describe('importOptionalPeer', () => {
  it('returns the module when it loads', async () => {
    const mod = await importOptionalPeer('protocols.mcp', () => import('node:path'));
    expect(typeof mod.join).toBe('function');
  });

  it('names the feature and the missing package as CONFIG_INVALID', async () => {
    const error = await importOptionalPeer('protocols.mcp', () => import(MISSING)).catch(
      (e: unknown) => e,
    );
    expect(isCommerceError(error) && error.code).toBe('CONFIG_INVALID');
    expect((error as Error).message).toContain(`protocols.mcp is enabled`);
    expect((error as Error).message).toContain(`"${MISSING}" is not installed`);
    expect((error as Error).message).toContain('`agent-commerce version`');
  });

  it('rethrows a missing file inside an installed package unchanged', async () => {
    // Not an uninstalled peer: a broken install or a version without that file
    const missingFile = Object.assign(
      new Error("Cannot find module '/app/node_modules/@x402/evm/dist/gone.js'"),
      { code: 'ERR_MODULE_NOT_FOUND' },
    );
    await expect(
      importOptionalPeer('payments.x402', () => Promise.reject(missingFile)),
    ).rejects.toBe(missingFile);
  });

  it('rethrows any other failure unchanged', async () => {
    const boom = new TypeError('module body threw');
    await expect(importOptionalPeer('payments.x402', () => Promise.reject(boom))).rejects.toBe(
      boom,
    );
  });
});
