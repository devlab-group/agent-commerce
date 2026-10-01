/**
 * What must hold before this gateway may settle a payment on the configured
 * network. Two callers share these checks: the provider runs them at
 * construction, so a library consumer who skips our config loader still gets
 * them, and the config loader runs them, so `validate` and `doctor` report
 * them too.
 *
 * Both run before any request, because a failure found in `settle()` would
 * come after the pipeline reserved the buyer's replay key.
 *
 * Imports no peer (no viem, no `@x402/*`), so the CLI can load it.
 */
import { CommerceError } from '../../core';
import { isLikelyLocalOrPrivateHost, isWellKnownDevAddress } from './dev-key-guard';
import {
  type DeploymentMode,
  type NetworkProfile,
  requireNetworkProfile,
  resolveDeploymentMode,
} from './networks';

/**
 * How the gateway authenticates to a remote facilitator.
 *
 * - `none`: send no credential; use it when the facilitator accepts
 *   anonymous requests.
 * - `bearer`: send a static token; no extra peer package is needed.
 * - `cdp`: Coinbase Developer Platform. The optional peer `@coinbase/x402`,
 *   imported only for this type, signs a fresh JWT per request.
 *
 * Any other auth type is refused at config load.
 */
export type FacilitatorAuth =
  | { readonly type: 'none' }
  | { readonly type: 'bearer'; readonly token: string }
  | { readonly type: 'cdp'; readonly apiKeyId: string; readonly apiKeySecret: string };

export type X402FacilitatorConfig =
  | { readonly mode: 'local'; readonly signerPrivateKey: string }
  | { readonly mode: 'remote'; readonly url: string; readonly auth: FacilitatorAuth };

export interface X402DeploymentInput {
  readonly network: string;
  readonly payTo: string;
  readonly asset: string;
  /** EIP-712 domain of the asset, as the token itself reports it */
  readonly assetName?: string;
  readonly assetVersion?: string;
  readonly facilitator: X402FacilitatorConfig;
  /** Must be `true` before anything settles on a mainnet */
  readonly allowMainnet?: boolean;
  /**
   * Must be `true` on mainnet when facilitator auth is `none`. A separate
   * decision from `allowMainnet`: it accepts settling without an account at
   * the facilitator, under its anonymous-access limits.
   */
  readonly allowUnauthenticatedFacilitator?: boolean;
  /** Error-path prefix, `payments.x402` by default */
  readonly configPath?: string;
  /** Settlement-recipient field named in errors, `payTo` by default */
  readonly payToField?: string;
}

export interface X402Deployment {
  readonly profile: NetworkProfile;
  readonly mode: DeploymentMode;
}

function invalid(message: string, path: string): CommerceError {
  return new CommerceError('CONFIG_INVALID', message, { details: { path } });
}

/**
 * Resolves the deployment and refuses the combinations that could move real
 * money by accident. The network must resolve first; the other checks are
 * independent.
 */
export function resolveX402Deployment(input: X402DeploymentInput): X402Deployment {
  const at = input.configPath ?? 'payments.x402';
  const payTo = input.payToField ?? 'payTo';
  const profile = requireNetworkProfile(input.network, `${at}.network`);
  const mode = resolveDeploymentMode(profile, input.facilitator.mode);

  // Local mode keeps a gas-paying key in the gateway process. A compromise
  // could expose that key, so mainnet requires a remote facilitator.
  if (profile.kind === 'mainnet' && input.facilitator.mode === 'local') {
    throw invalid(
      `${at}: network "${profile.id}" (${profile.displayName}) is a mainnet and cannot be served by facilitator.mode "local". A mainnet deployment must settle through a remote facilitator.`,
      `${at}.facilitator.mode`,
    );
  }

  if (mode === 'mainnet' && input.allowMainnet !== true) {
    throw invalid(
      `${at}: network "${profile.id}" (${profile.displayName}) settles real funds. Set ${at}.allowMainnet: true to acknowledge this explicitly - it is never the default.`,
      `${at}.allowMainnet`,
    );
  }

  if (input.facilitator.mode === 'remote') {
    assertFacilitatorUrlIsSafe(input.facilitator.url, mode, at);
    // The authorization fixes recipient, amount and chain, so a facilitator
    // cannot redirect funds. A credential adds an account: rate limits, terms
    // and support. On mainnet, going without one is an explicit choice.
    if (
      mode === 'mainnet' &&
      input.facilitator.auth.type === 'none' &&
      input.allowUnauthenticatedFacilitator !== true
    ) {
      throw invalid(
        `${at}: no credential is configured for facilitator ${describeOrigin(input.facilitator.url)} on mainnet. Set ${at}.allowUnauthenticatedFacilitator: true to accept anonymous access and the facilitator's limits, or configure facilitator.auth.`,
        `${at}.allowUnauthenticatedFacilitator`,
      );
    }
    // A blank credential reaches the facilitator as "unauthenticated" and fails
    // every payment after the buyer signed. `${VAR:- }` resolving to whitespace
    // is the usual cause.
    for (const [field, value] of credentialFields(input.facilitator.auth)) {
      if (value.trim() === '') {
        throw invalid(
          `${at}: facilitator.auth.type is "${input.facilitator.auth.type}" but ${field} is empty. An empty credential is refused rather than sent.`,
          `${at}.facilitator.auth.${field}`,
        );
      }
    }
  }

  // The config loader's address check refuses this too; repeated here for a
  // library consumer who calls `createX402PaymentProvider` without it
  if (/^0x0{40}$/i.test(input.payTo)) {
    throw invalid(
      `${at}: "${payTo}" is the zero address. Every payment settled there is destroyed.`,
      `${at}.${payTo}`,
    );
  }

  // Anyone can spend from a well-known Anvil address. `dev-key-guard` refuses
  // one behind a public RPC; this refuses one on any non-local deployment,
  // whose RPC host says nothing about where a remote facilitator settles.
  if (mode !== 'local' && isWellKnownDevAddress(input.payTo)) {
    throw invalid(
      `${at}: "${payTo}" (${input.payTo}) is a well-known Anvil development address and this is a ${mode} deployment. Anyone can spend what settles there. Set ${payTo} to your own merchant wallet.`,
      `${at}.${payTo}`,
    );
  }

  // Mainnet only: a testnet is where pointing at a mock token is normal
  const canonical = profile.canonicalAsset;
  if (mode === 'mainnet' && canonical) {
    if (!sameAddress(input.asset, canonical.address)) {
      throw invalid(
        `${at}: asset ${input.asset} is not ${canonical.symbol} on ${profile.displayName} (expected ${canonical.address}). Settling a mainnet payment in an unintended token is refused.`,
        `${at}.asset`,
      );
    }
    // The buyer signs the EIP-712 domain and the scheme checks it. A wrong one
    // refuses every payment with `invalid_exact_evm_token_name_mismatch` after
    // the buyer signed, so it is caught here, before the gateway starts.
    if (input.assetName !== undefined && input.assetName !== canonical.name) {
      throw invalid(
        `${at}: assetName "${input.assetName}" is not the EIP-712 domain name ${canonical.symbol} reports on ${profile.displayName} (expected "${canonical.name}"). Every payment would be refused after the buyer signed.`,
        `${at}.assetName`,
      );
    }
    if (input.assetVersion !== undefined && input.assetVersion !== canonical.version) {
      throw invalid(
        `${at}: assetVersion "${input.assetVersion}" is not the EIP-712 domain version ${canonical.symbol} reports on ${profile.displayName} (expected "${canonical.version}").`,
        `${at}.assetVersion`,
      );
    }
  }

  return { profile, mode };
}

/**
 * A facilitator sees every payment authorization this gateway handles. Plain
 * HTTP puts those on the wire in the clear and lets anyone in the path rewrite
 * a settlement result, so it is allowed only to a local or private host, and
 * never on a mainnet.
 */
function assertFacilitatorUrlIsSafe(url: string, mode: DeploymentMode, at: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw new CommerceError('CONFIG_INVALID', `${at}: facilitator.url is not a valid URL`, {
      cause,
      details: { path: `${at}.facilitator.url` },
    });
  }

  if (parsed.protocol === 'https:') return;
  if (parsed.protocol !== 'http:') {
    throw invalid(
      `${at}: facilitator ${describeOrigin(url)} must be reached over https (or http on a local/private host); got "${parsed.protocol}//"`,
      `${at}.facilitator.url`,
    );
  }
  if (mode !== 'mainnet' && isLikelyLocalOrPrivateHost(parsed.hostname)) return;

  // The origin, never the whole URL: the path can carry a tenant or an API
  // key, and this message reaches `validate`, `doctor`, startup output and CI logs
  throw invalid(
    `${at}: facilitator ${describeOrigin(url)} is reached over plain HTTP. Payment authorizations and settlement results would travel unencrypted. Use https, or point at a local/private host on a non-mainnet deployment.`,
    `${at}.facilitator.url`,
  );
}

// Origin only: a facilitator URL can carry a tenant path or an API key
function describeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '[unparseable facilitator.url]';
  }
}

// The secret-bearing fields of an auth block, for emptiness checks only. Never logged
function credentialFields(auth: FacilitatorAuth): readonly (readonly [string, string])[] {
  switch (auth.type) {
    case 'bearer':
      return [['token', auth.token]];
    case 'cdp':
      return [
        ['apiKeyId', auth.apiKeyId],
        ['apiKeySecret', auth.apiKeySecret],
      ];
    default:
      return [];
  }
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
