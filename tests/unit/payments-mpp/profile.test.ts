import { readFileSync } from 'node:fs';
import * as evm from 'mppx/evm';
import { describe, expect, it } from 'vitest';
import {
  MPP_DESCRIPTOR,
  MPP_PROFILE,
  MPP_SPEC_COMMIT,
  MPP_SPEC_DRAFTS,
  MPPX_VERSION,
} from '../../../src/payments/mpp/index.js';

// The profile avoids a runtime peer import; these checks catch copied values
// that drift from the pinned mppx release
describe('pinned MPP profile', () => {
  it('names the same intent and method as the pinned mppx release', () => {
    expect(MPP_PROFILE.intent).toBe(evm.Types.chargeIntent);
    expect(MPP_PROFILE.method).toBe(evm.Types.paymentMethod);
  });

  it('names a credential type the pinned release actually offers', () => {
    expect([...evm.Types.credentialTypes]).toContain(MPP_PROFILE.credentialType);
  });

  it('pins the mppx version the repo installs', () => {
    // mppx does not export package.json, so read the installed file directly
    const installed = JSON.parse(
      readFileSync(new URL('../../../node_modules/mppx/package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(installed.version).toBe(MPPX_VERSION);
  });

  it('records a full upstream commit, not a branch or a short sha', () => {
    expect(MPP_SPEC_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('MPP descriptor', () => {
  it('is experimental because settlement tests use a mocked facilitator', () => {
    expect(MPP_DESCRIPTOR.status).toBe('experimental');
  });

  it('names the pinned core draft in supportedSpec', () => {
    expect(MPP_DESCRIPTOR.supportedSpec).toContain(MPP_SPEC_DRAFTS.core);
  });

  it('lists the non-EIP-3009 credential types as unsupported', () => {
    for (const credential of ['permit2', 'transaction', 'hash']) {
      expect(MPP_DESCRIPTOR.unsupported).toContain(`credential=${credential}`);
    }
  });

  it('claims no capability it also lists as unsupported', () => {
    const claimed = new Set(MPP_DESCRIPTOR.capabilities);
    for (const gap of MPP_DESCRIPTOR.unsupported ?? []) expect(claimed.has(gap)).toBe(false);
  });
});
