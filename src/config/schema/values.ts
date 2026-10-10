// Readers for leaves that env substitution may have turned into strings, and addresses
import { CommerceError } from '../../core';
import { isEvmAddress, isEvmZeroAddress } from '../../payments/x402/addresses';

export function toNumber(
  value: number | string,
  path: string,
  bounds: { min?: number; max?: number } = {},
): number {
  // Plain decimal digits only. `Number('')` is 0, which `server.port` accepts
  // ("let the OS pick"), so an empty `${PORT:-}` would bind a random port.
  // `Number` also accepts `"0x50"` and `"1e3"` for fields documented as decimal.
  if (typeof value === 'string' && !/^\s*\d+\s*$/.test(value)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Configuration value at "${path}" must be an integer written in decimal digits (got ${value === '' ? 'an empty string' : `"${value}"`})`,
      { details: { path } },
    );
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Configuration value at "${path}" must be an integer`,
      {
        details: { path },
      },
    );
  }
  if (bounds.min !== undefined && n < bounds.min) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Configuration value at "${path}" must be >= ${bounds.min}`,
      {
        details: { path },
      },
    );
  }
  if (bounds.max !== undefined && n > bounds.max) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Configuration value at "${path}" must be <= ${bounds.max}`,
      {
        details: { path },
      },
    );
  }
  return n;
}

export function toBoolean(value: boolean | string, path: string): boolean {
  if (typeof value === 'boolean') return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new CommerceError(
    'CONFIG_INVALID',
    `Configuration value at "${path}" must be a boolean ("true" or "false")`,
    { details: { path } },
  );
}

export function validateAddress(path: string, value: string): void {
  if (!isEvmAddress(value)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Configuration value at "${path}" is not a plausible address (expected "0x" followed by 40 hex characters)`,
      { details: { path } },
    );
  }
  if (isEvmZeroAddress(value)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Configuration value at "${path}" must not be the zero address`,
      {
        details: { path },
      },
    );
  }
}
