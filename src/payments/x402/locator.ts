/**
 * Public payment coordinates returned under `RECONCILIATION_METADATA_KEY`
 * for later reconciliation. Locators contain transfer details and derived
 * metadata, excluding signatures, payloads and transaction bytes. Field names
 * avoid "token" because the receipt store redacts values under such keys.
 */
import { getAddress } from 'viem';

export const LOCATOR_VERSION = 1;

// Bound decimal input length to cover Date's range without parsing large integers
const SECONDS = /^\d{1,13}$/;
const MAX_DATE_MS = 8.64e15;

/**
 * Converts unsigned decimal Unix seconds to ISO time, or undefined for invalid
 * or out-of-range input
 */
export function isoFromSeconds(seconds: string): string | undefined {
  const ms = SECONDS.test(seconds) ? Number(seconds) * 1000 : Number.NaN;
  return ms <= MAX_DATE_MS ? new Date(ms).toISOString() : undefined;
}

export interface Eip3009Authorization {
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly validAfter: string;
  readonly validBefore: string;
  readonly nonce: string;
}

/** Builds the shared EIP-3009 locator used by x402 and MPP */
export function eip3009Locator(
  network: string,
  asset: string,
  authorization: Eip3009Authorization,
): Readonly<Record<string, unknown>> {
  const { from, to, value, validAfter, validBefore, nonce } = authorization;
  return withExpiry(
    {
      v: LOCATOR_VERSION,
      network,
      method: 'eip3009',
      asset: getAddress(asset),
      from: getAddress(from),
      to: getAddress(to),
      value,
      nonce: nonce.toLowerCase(),
      validAfter,
      validBefore,
    },
    validBefore,
  );
}

export interface Permit2Transfer {
  readonly asset: string;
  readonly owner: string;
  /** Recipient named in the signed witness for the x402 proxy transfer */
  readonly to: string;
  readonly amount: string;
  readonly nonce: string;
  readonly deadline: string;
  readonly validAfter: string;
  readonly proxy: string;
}

/** A Permit2 transfer's locator */
export function permit2Locator(
  network: string,
  transfer: Permit2Transfer,
): Readonly<Record<string, unknown>> {
  const { asset, owner, to, amount, nonce, deadline, validAfter, proxy } = transfer;
  return withExpiry(
    {
      v: LOCATOR_VERSION,
      network,
      method: 'permit2',
      asset: getAddress(asset),
      owner: getAddress(owner),
      to: getAddress(to),
      amount,
      nonce,
      deadline,
      validAfter,
      proxy: getAddress(proxy),
    },
    deadline,
  );
}

function withExpiry(
  locator: Readonly<Record<string, unknown>>,
  seconds: string,
): Readonly<Record<string, unknown>> {
  const expiresAt = isoFromSeconds(seconds);
  return expiresAt !== undefined ? { ...locator, expiresAt } : locator;
}
