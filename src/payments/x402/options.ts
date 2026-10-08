/**
 * Resolves an x402 option into offer terms at config load, so `validate`
 * reports invalid options before startup. This module uses no SDK.
 *
 * Omitted assets use `canonicalAsset`. Overrides for the default token must
 * match its metadata; another token needs its own, including the EIP-712 domain
 * on EVM.
 */
import { CommerceError } from '../../core';
import { isBurnAddress, normalizeAddress, sameAddress } from './addresses';
import { type CustomNetworks, requireX402Network, type X402Network } from './networks';

export interface X402OptionInput {
  readonly scheme?: string;
  readonly network: string;
  readonly payTo: string;
  readonly asset?: string;
  readonly assetName?: string;
  readonly assetVersion?: string;
  readonly assetDecimals?: number;
}

export interface ResolvedX402Option {
  readonly scheme: 'exact';
  readonly network: X402Network;
  /** Wire form: raw `workchain:hex` on TON */
  readonly payTo: string;
  readonly asset: string;
  /** EIP-712 domain; EVM only */
  readonly assetName?: string;
  readonly assetVersion?: string;
  readonly assetDecimals: number;
  /**
   * Default token symbol when `asset` is omitted; resource prices must use
   * this symbol or USD
   */
  readonly defaultAssetSymbol?: string;
}

// Incorrect EIP-712 domain values invalidate the buyer's signature
const FIELD_MEANINGS = {
  assetName: 'EIP-712 domain name',
  assetVersion: 'EIP-712 domain version',
  assetDecimals: 'decimals',
} as const;

const ADDRESS_SHAPES = {
  evm: '"0x" followed by 40 hex characters',
  svm: 'a base58 public key of 32 bytes',
  tvm: 'a raw "0:<64 hex>" or user-friendly address',
} as const;

function invalid(message: string, path: string): CommerceError {
  return new CommerceError('CONFIG_INVALID', message, { details: { path } });
}

export function resolveX402Option(
  input: X402OptionInput,
  path: string,
  custom?: CustomNetworks,
): ResolvedX402Option {
  if (input.scheme !== undefined && input.scheme !== 'exact') {
    throw invalid(
      `${path}.scheme: "${input.scheme}" is not supported; the only x402 scheme is "exact"`,
      `${path}.scheme`,
    );
  }
  const network = requireX402Network(input.network, `${path}.network`, custom);
  const address = (field: 'payTo' | 'asset', value: string): string => {
    const wire = normalizeAddress(network, value);
    if (wire === undefined) {
      throw invalid(
        // The value is not echoed: a swapped variable could put a key here
        `${path}.${field} is not a plausible address on ${network.displayName} (expected ${ADDRESS_SHAPES[network.family]})`,
        `${path}.${field}`,
      );
    }
    return wire;
  };

  const payTo = address('payTo', input.payTo);
  if (isBurnAddress(network, payTo)) {
    throw invalid(
      `${path}.payTo is the zero address of ${network.displayName}. Every payment settled there is destroyed.`,
      `${path}.payTo`,
    );
  }

  if (network.family !== 'evm') {
    for (const field of ['assetName', 'assetVersion'] as const) {
      if (input[field] !== undefined) {
        throw invalid(
          `${path}.${field}: an EIP-712 domain applies to EVM tokens only, not to ${network.displayName}`,
          `${path}.${field}`,
        );
      }
    }
  }

  const canonical = network.canonicalAsset;
  const domain = canonical && 'name' in canonical ? canonical : undefined;

  const asset = input.asset !== undefined ? address('asset', input.asset) : undefined;
  if (asset !== undefined && isBurnAddress(network, asset)) {
    throw invalid(`${path}.asset must not be the zero address`, `${path}.asset`);
  }

  // The default asset applies when the option names none or names it exactly
  if (canonical && (asset === undefined || sameAddress(network, asset, canonical.address))) {
    const expected = {
      assetName: domain?.name,
      assetVersion: domain?.version,
      assetDecimals: canonical.decimals,
    };
    for (const field of ['assetName', 'assetVersion', 'assetDecimals'] as const) {
      const given = input[field];
      if (given !== undefined && given !== expected[field]) {
        throw invalid(
          `${path}.${field} does not match ${canonical.symbol} on ${network.displayName}, which reports ${FIELD_MEANINGS[field]} ${JSON.stringify(expected[field])}. Remove ${field}, or set asset to the token it describes.`,
          `${path}.${field}`,
        );
      }
    }
    return {
      scheme: 'exact',
      network,
      payTo,
      asset: asset ?? canonical.address,
      ...(domain ? { assetName: domain.name, assetVersion: domain.version } : {}),
      assetDecimals: canonical.decimals,
      ...(asset === undefined ? { defaultAssetSymbol: canonical.symbol } : {}),
    };
  }

  // Another token: nothing about it can be borrowed from the default
  const required =
    network.family === 'evm'
      ? (['asset', 'assetName', 'assetVersion', 'assetDecimals'] as const)
      : (['asset', 'assetDecimals'] as const);
  const missing = required.filter((field) => input[field] === undefined);
  if (asset === undefined || missing.length > 0) {
    throw invalid(
      canonical
        ? `${path}: a token other than ${canonical.symbol} on ${network.displayName} needs ${missing.join(', ')}`
        : `${path}: ${network.displayName} has no default asset, so the option needs ${missing.join(', ')}`,
      `${path}.${missing[0] ?? 'asset'}`,
    );
  }
  return {
    scheme: 'exact',
    network,
    payTo,
    asset,
    ...(network.family === 'evm'
      ? { assetName: input.assetName as string, assetVersion: input.assetVersion as string }
      : {}),
    assetDecimals: input.assetDecimals as number,
  };
}
