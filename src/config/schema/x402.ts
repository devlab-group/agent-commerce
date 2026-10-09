// The x402 rail: direct or listed options, declared networks and the facilitator
import type { z } from 'zod';
import { CommerceError } from '../../core';
import { resolveX402Deployment, type X402FacilitatorConfig } from '../../payments/x402/guardrails';
import {
  type CustomNetworkDeclaration,
  findX402Network,
  validateCustomNetworks,
} from '../../payments/x402/networks';
import { resolveX402Option, type X402OptionInput } from '../../payments/x402/options';
import { X402_DEFAULT_PAYMENT_FLOW } from '../../payments/x402/payment-flow';
import type { FacilitatorSchema, RawConfig } from './raw';
import type { GatewayConfig, X402OptionConfig } from './types';
import { toBoolean, toNumber } from './values';

type X402Config = NonNullable<GatewayConfig['payments']['x402']>;

export interface NormalizedX402 {
  readonly config: X402Config;
  /** Every option, resolved, in order */
  readonly options: readonly X402OptionConfig[];
  /**
   * Default symbols for options omitting `asset`; prices must use USD or
   * the shared symbol
   */
  readonly defaultAssetSymbols: readonly string[];
}

function x402Invalid(message: string, path: string): CommerceError {
  return new CommerceError('CONFIG_INVALID', message, { details: { path } });
}

// The fields of one option, as they appear directly under `payments.x402`
const DIRECT_OPTION_FIELDS = [
  'network',
  'payTo',
  'asset',
  'assetName',
  'assetVersion',
  'assetDecimals',
  'assetTransferMethod',
] as const;

type RawX402 = NonNullable<RawConfig['payments']['x402']>;

// An entry of `options`, or `payments.x402` itself in the direct form
interface RawX402Option {
  readonly scheme?: string | undefined;
  readonly network?: string | undefined;
  readonly payTo?: string | undefined;
  readonly asset?: string | undefined;
  readonly assetName?: string | undefined;
  readonly assetVersion?: string | undefined;
  readonly assetDecimals?: number | string | undefined;
  readonly assetTransferMethod?: string | undefined;
}

function x402OptionInput(raw: RawX402Option, path: string): X402OptionInput {
  return {
    ...(raw.scheme !== undefined ? { scheme: raw.scheme } : {}),
    network: raw.network as string,
    payTo: raw.payTo as string,
    ...(raw.asset !== undefined ? { asset: raw.asset } : {}),
    ...(raw.assetName !== undefined ? { assetName: raw.assetName } : {}),
    ...(raw.assetVersion !== undefined ? { assetVersion: raw.assetVersion } : {}),
    ...(raw.assetTransferMethod !== undefined
      ? { assetTransferMethod: raw.assetTransferMethod }
      : {}),
    ...(raw.assetDecimals !== undefined
      ? {
          assetDecimals: toNumber(raw.assetDecimals, `${path}.assetDecimals`, { min: 0, max: 36 }),
        }
      : {}),
  };
}

/**
 * Resolves direct `payments.x402` fields and a one-entry `options` array
 * identically, preserving the original config form.
 */
export function normalizeX402(raw: RawX402): NormalizedX402 {
  const at = 'payments.x402';
  const direct = DIRECT_OPTION_FIELDS.filter((field) => raw[field] !== undefined);
  if (raw.options !== undefined && direct.length > 0) {
    throw x402Invalid(
      `${at}: give the option either under ${at}.options or directly (${direct.join(', ')}), not both`,
      `${at}.options`,
    );
  }
  if (raw.options?.length === 0) {
    throw x402Invalid(`${at}.options is empty; list at least one option`, `${at}.options`);
  }
  if (raw.options === undefined) {
    for (const field of ['network', 'payTo'] as const) {
      if (raw[field] === undefined) {
        throw x402Invalid(
          `${at}.${field} is required, unless the options are listed under ${at}.options`,
          `${at}.${field}`,
        );
      }
    }
  }

  // `kind` and `displayName` declare a network; `rpcUrl` alone sets the
  // endpoint of a built-in or declared one
  const settings = raw.networks ?? {};
  const declared: Record<string, CustomNetworkDeclaration> = {};
  for (const [id, entry] of Object.entries(settings)) {
    if (entry.kind === undefined && entry.displayName === undefined) continue;
    if (entry.kind === undefined || entry.displayName === undefined) {
      const path = `${at}.networks.${id}`;
      throw x402Invalid(`${path}: declaring a network needs both kind and displayName`, path);
    }
    declared[id] = { kind: entry.kind, displayName: entry.displayName };
  }
  const networks = Object.keys(declared).length > 0 ? declared : undefined;
  if (networks !== undefined) validateCustomNetworks(networks, `${at}.networks`);
  for (const id of Object.keys(settings)) {
    if (!findX402Network(id, networks)) {
      const path = `${at}.networks.${id}`;
      throw x402Invalid(
        `${path}: "${id}" is not a known network; declare it with kind and displayName`,
        path,
      );
    }
  }

  const entries: (readonly [string, RawX402Option])[] =
    raw.options !== undefined
      ? raw.options.map((option, i) => [`${at}.options[${i}]`, option] as const)
      : [[at, raw]];
  const resolved = entries.map(([path, entry]) =>
    resolveX402Option(x402OptionInput(entry, path), path, networks),
  );

  const facilitator = normalizeFacilitator(raw.facilitator);
  const allowMainnet =
    raw.allowMainnet !== undefined ? toBoolean(raw.allowMainnet, `${at}.allowMainnet`) : undefined;
  const allowUnauthenticatedFacilitator =
    raw.allowUnauthenticatedFacilitator !== undefined
      ? toBoolean(raw.allowUnauthenticatedFacilitator, `${at}.allowUnauthenticatedFacilitator`)
      : undefined;

  const rpcOwners = new Map<string, string>();
  const seen = new Set<string>();
  let firstMode: string | undefined;
  const options = resolved.map((option, i): X402OptionConfig => {
    const path = entries[i]?.[0] as string;
    const network = option.network.id;
    // Require distinct RPC endpoints so each network's health check reads its chain
    const rpcUrl = settings[network]?.rpcUrl ?? raw.rpcUrl;
    if (rpcUrl === undefined) {
      throw x402Invalid(
        `${path}.network: no RPC endpoint for ${network}; set ${at}.rpcUrl or ${at}.networks.${network}.rpcUrl`,
        `${at}.rpcUrl`,
      );
    }
    const owner = rpcOwners.get(rpcUrl);
    if (owner !== undefined && owner !== network) {
      throw x402Invalid(
        `${at}: ${owner} and ${network} would use the same RPC endpoint; give each network its own ${at}.networks.<id>.rpcUrl`,
        `${at}.networks`,
      );
    }
    rpcOwners.set(rpcUrl, network);

    const key = `${network}|${option.asset.toLowerCase()}|${option.payTo.toLowerCase()}`;
    if (seen.has(key)) {
      throw x402Invalid(
        `${path}: repeats an earlier option, the same asset to the same payTo on ${network}`,
        path,
      );
    }
    seen.add(key);

    // The provider makes the same call at construction; running it here lets
    // `agent-commerce validate` report an unsafe deployment before boot
    const { mode } = resolveX402Deployment({
      network,
      payTo: option.payTo,
      asset: option.asset,
      ...(option.assetName !== undefined ? { assetName: option.assetName } : {}),
      ...(option.assetVersion !== undefined ? { assetVersion: option.assetVersion } : {}),
      facilitator,
      ...(allowMainnet !== undefined ? { allowMainnet } : {}),
      ...(allowUnauthenticatedFacilitator !== undefined ? { allowUnauthenticatedFacilitator } : {}),
      ...(networks !== undefined ? { customNetworks: networks } : {}),
    });
    // Keep all offers in one deployment mode: local, testnet or mainnet
    if (firstMode !== undefined && mode !== firstMode) {
      throw x402Invalid(
        `${path}.network: ${network} is a ${mode} network, but the first option is on a ${firstMode} one; every option must be on the same kind of network`,
        `${path}.network`,
      );
    }
    firstMode = mode;

    return {
      network,
      rpcUrl,
      asset: option.asset,
      ...(option.assetName !== undefined ? { assetName: option.assetName } : {}),
      ...(option.assetVersion !== undefined ? { assetVersion: option.assetVersion } : {}),
      assetDecimals: option.assetDecimals,
      payTo: option.payTo,
      ...(option.assetTransferMethod === 'permit2'
        ? { assetTransferMethod: 'permit2' as const }
        : {}),
    };
  });
  const first = options[0] as X402OptionConfig;

  const config: X402Config = {
    enabled: toBoolean(raw.enabled, `${at}.enabled`),
    ...first,
    maxTimeoutSeconds: toNumber(raw.maxTimeoutSeconds, `${at}.maxTimeoutSeconds`, { min: 1 }),
    paymentFlow: raw.paymentFlow ?? X402_DEFAULT_PAYMENT_FLOW,
    facilitator,
    ...(allowMainnet !== undefined ? { allowMainnet } : {}),
    ...(allowUnauthenticatedFacilitator !== undefined ? { allowUnauthenticatedFacilitator } : {}),
    ...(networks !== undefined ? { networks } : {}),
    options,
  };

  return {
    config,
    options,
    defaultAssetSymbols: [
      ...new Set(resolved.flatMap((option) => option.defaultAssetSymbol ?? [])),
    ],
  };
}

export function normalizeFacilitator(
  raw: z.infer<typeof FacilitatorSchema>,
): X402FacilitatorConfig {
  return raw.mode === 'local'
    ? { mode: 'local', signerPrivateKey: raw.signerPrivateKey }
    : { mode: 'remote', url: raw.url, auth: raw.auth ?? { type: 'none' } };
}
