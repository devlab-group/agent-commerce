/**
 * Everything that must be true before this gateway is allowed to settle a
 * payment on the configured network.
 *
 * One definition, two callers: the provider runs it at construction so a
 * library consumer who never touches our config loader still gets the checks,
 * and `doctor` runs it against the parsed config so an operator sees the same
 * verdict without starting the gateway. Sharing a *call* is not sharing a
 * definition — the checks live here, and nothing re-implements them.
 *
 * Every failure is a startup failure. None of these are request-time
 * decisions: a deployment that is unsafe is unsafe before the first buyer
 * arrives, and finding out during `settle()` means the buyer's authorisation
 * is already burned.
 *
 * Peer-free by construction (no viem, no `@x402/*`) so the CLI can import it.
 */
import { CommerceError } from '../../core/index.js';
import { isLikelyLocalOrPrivateHost, isWellKnownDevAddress } from './dev-key-guard.js';
import {
  type DeploymentMode,
  type NetworkProfile,
  requireNetworkProfile,
  resolveDeploymentMode,
} from './networks.js';

/**
 * How the gateway authenticates to a remote facilitator.
 *
 * Deliberately generic: x402 facilitators are not a Coinbase-only category,
 * and a scheme that only fits one vendor's credentials would make the
 * abstraction a fiction. `bearer` covers every facilitator that takes a static
 * token; a facilitator needing per-request signed credentials (CDP's JWT among
 * them) is not supported yet and is refused rather than silently sent nothing.
 */
export type FacilitatorAuth =
  | { readonly type: 'none' }
  | { readonly type: 'bearer'; readonly token: string };

export type X402FacilitatorConfig =
  | { readonly mode: 'local'; readonly signerPrivateKey: string }
  | { readonly mode: 'remote'; readonly url: string; readonly auth: FacilitatorAuth };

export interface X402DeploymentInput {
  readonly network: string;
  readonly payTo: string;
  readonly asset: string;
  readonly facilitator: X402FacilitatorConfig;
  /** Required, and required to be `true`, before anything settles on a mainnet. */
  readonly allowMainnet?: boolean;
}

export interface X402Deployment {
  readonly profile: NetworkProfile;
  readonly mode: DeploymentMode;
}

function invalid(message: string, path: string): CommerceError {
  return new CommerceError('CONFIG_INVALID', message, { details: { path } });
}

/**
 * Resolves the deployment and refuses every combination that could move real
 * money by accident. Order matters only in that the network must resolve
 * first; the rest are independent.
 */
export function resolveX402Deployment(input: X402DeploymentInput): X402Deployment {
  const profile = requireNetworkProfile(input.network, 'payments.x402.network');
  const mode = resolveDeploymentMode(profile, input.facilitator.mode);

  // The in-process facilitator signs with a key this process holds. On a
  // mainnet that is a hot wallet inside the resource server — the arrangement
  // this project exists to avoid — so it is not a warning, it is refused.
  if (profile.kind === 'mainnet' && input.facilitator.mode === 'local') {
    throw invalid(
      `payments.x402: network "${profile.id}" (${profile.displayName}) is a mainnet and cannot be served by facilitator.mode "local". A mainnet deployment must settle through a remote facilitator.`,
      'payments.x402.facilitator.mode',
    );
  }

  if (mode === 'mainnet' && input.allowMainnet !== true) {
    throw invalid(
      `payments.x402: network "${profile.id}" (${profile.displayName}) settles real funds. Set payments.x402.allowMainnet: true to acknowledge this explicitly — it is never the default.`,
      'payments.x402.allowMainnet',
    );
  }

  if (input.facilitator.mode === 'remote') {
    assertFacilitatorUrlIsSafe(input.facilitator.url, mode);
    if (mode === 'mainnet' && input.facilitator.auth.type === 'none') {
      throw invalid(
        'payments.x402: a mainnet facilitator must be authenticated. Set payments.x402.facilitator.auth to a supported type — an unauthenticated production facilitator is refused.',
        'payments.x402.facilitator.auth',
      );
    }
    if (input.facilitator.auth.type === 'bearer' && input.facilitator.auth.token.trim() === '') {
      throw invalid(
        'payments.x402: facilitator.auth.type is "bearer" but the token is empty. An empty credential is refused rather than sent.',
        'payments.x402.facilitator.auth.token',
      );
    }
  }

  // The private key behind every well-known Anvil address is public knowledge.
  // `dev-key-guard` already refuses one against a public *RPC*; this refuses
  // one on any non-local *deployment*, which is the case a remote facilitator
  // creates — there the RPC host says nothing about where settlement lands.
  if (mode !== 'local' && isWellKnownDevAddress(input.payTo)) {
    throw invalid(
      `payments.x402: "payTo" (${input.payTo}) is a well-known Anvil development address and this is a ${mode} deployment. Anyone can spend what settles there. Set payTo to your own merchant wallet.`,
      'payments.x402.payTo',
    );
  }

  // Mainnet only. A testnet is exactly where pointing at a mock token is the
  // right thing to do, so the same check there would block the normal case.
  const canonical = profile.canonicalAsset;
  if (mode === 'mainnet' && canonical && !sameAddress(input.asset, canonical.address)) {
    throw invalid(
      `payments.x402: asset ${input.asset} is not ${canonical.symbol} on ${profile.displayName} (expected ${canonical.address}). Settling a mainnet payment in an unintended token is refused.`,
      'payments.x402.asset',
    );
  }

  return { profile, mode };
}

/**
 * A facilitator sees every payment authorisation this gateway handles. Plain
 * HTTP to one on a public network puts those on the wire in the clear and
 * lets anyone in the path rewrite a settlement result, so it is allowed only
 * where the endpoint cannot leave the host — a local or private address.
 */
function assertFacilitatorUrlIsSafe(url: string, mode: DeploymentMode): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `payments.x402: facilitator.url "${url}" is not a valid URL`,
      { cause, details: { path: 'payments.x402.facilitator.url' } },
    );
  }

  if (parsed.protocol === 'https:') return;
  if (parsed.protocol !== 'http:') {
    throw invalid(
      `payments.x402: facilitator.url must be https (or http on a local/private host); got "${parsed.protocol}//"`,
      'payments.x402.facilitator.url',
    );
  }
  if (mode !== 'mainnet' && isLikelyLocalOrPrivateHost(parsed.hostname)) return;

  throw invalid(
    `payments.x402: facilitator.url "${url}" uses plain HTTP. Payment authorisations and settlement results would travel unencrypted. Use https, or point at a local/private host on a non-mainnet deployment.`,
    'payments.x402.facilitator.url',
  );
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
