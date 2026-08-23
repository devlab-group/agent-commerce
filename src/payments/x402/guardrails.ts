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
 * Deliberately a list, not a vendor: x402 facilitators are not a Coinbase-only
 * category, and a scheme that only fitted one vendor's credentials would make
 * the abstraction a fiction.
 *
 * - `none` — the facilitator takes no credential (the public testnet one).
 * - `bearer` — a static token. Covers most self-hosted and third-party
 * facilitators, and needs nothing installed.
 * - `cdp` — Coinbase Developer Platform, which signs a fresh JWT per request
 * over method + host + path, so a static header cannot express it. Handled by
 * the optional peer `@coinbase/x402`, imported only when this type is
 * configured. Anyone not using CDP never installs it.
 *
 * A facilitator whose scheme is none of these is refused at config load rather
 * than sent nothing.
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
  /** EIP-712 domain of the asset, as the token itself reports it. */
  readonly assetName?: string;
  readonly assetVersion?: string;
  readonly facilitator: X402FacilitatorConfig;
  /** Required, and required to be `true`, before anything settles on a mainnet. */
  readonly allowMainnet?: boolean;
  /**
   * Required, and required to be `true`, to settle on a mainnet through a
   * facilitator that takes no credential.
   *
   * Separate from `allowMainnet` because it names a different decision: not
   * "I meant to use real money" but "I accept this particular counterparty
   * without an account, terms, or anyone to call".
   */
  readonly allowUnauthenticatedFacilitator?: boolean;
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

  // The in-process facilitator signs with a key this process holds. Not a
  // custody problem — that signer never holds buyer or merchant funds, it pays
  // gas and broadcasts `transferWithAuthorization`, and the money moves buyer
  // to merchant directly on-chain. What it *is*, on a mainnet, is a funded key
  // inside the resource server: compromise that process and an attacker drains
  // the gas wallet and broadcasts from it. Separate processes, separate blast
  // radius — so it is refused, not warned about.
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
    // Not a funds check. An EIP-3009 authorisation names its recipient, its
    // amount and its chain, so a facilitator can broadcast exactly that
    // transfer or nothing — it cannot redirect the money. What a credential
    // buys is a *relationship*: rate limits, terms, someone to call when
    // settlement stops. Running production payments through a counterparty you
    // have none of that with is a real choice, and this is where it gets made
    // explicitly rather than by omission.
    if (
      mode === 'mainnet' &&
      input.facilitator.auth.type === 'none' &&
      input.allowUnauthenticatedFacilitator !== true
    ) {
      throw invalid(
        `payments.x402: facilitator ${describeOrigin(input.facilitator.url)} takes no credential, and this is a mainnet deployment. It will see every payment authorisation you handle, with no account, terms or support behind it. Set payments.x402.allowUnauthenticatedFacilitator: true to accept that, or configure facilitator.auth.`,
        'payments.x402.allowUnauthenticatedFacilitator',
      );
    }
    // An empty credential is refused rather than sent: a blank token or key
    // reaches the facilitator as "unauthenticated" and fails every payment
    // after the buyer has already signed. `${VAR:- }` resolving to whitespace
    // is the realistic way this happens.
    for (const [field, value] of credentialFields(input.facilitator.auth)) {
      if (value.trim() === '') {
        throw invalid(
          `payments.x402: facilitator.auth.type is "${input.facilitator.auth.type}" but ${field} is empty. An empty credential is refused rather than sent.`,
          `payments.x402.facilitator.auth.${field}`,
        );
      }
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
  if (mode === 'mainnet' && canonical) {
    if (!sameAddress(input.asset, canonical.address)) {
      throw invalid(
        `payments.x402: asset ${input.asset} is not ${canonical.symbol} on ${profile.displayName} (expected ${canonical.address}). Settling a mainnet payment in an unintended token is refused.`,
        'payments.x402.asset',
      );
    }
    // The EIP-712 domain is signed by the buyer and checked by the scheme. Get
    // it wrong and every payment is refused `invalid_exact_evm_token_name_mismatch`
    // *after* the buyer signed — a config error charged to the buyer's patience.
    // Caught here instead, before the gateway starts.
    if (input.assetName !== undefined && input.assetName !== canonical.name) {
      throw invalid(
        `payments.x402: assetName "${input.assetName}" is not the EIP-712 domain name ${canonical.symbol} reports on ${profile.displayName} (expected "${canonical.name}"). Every payment would be refused after the buyer signed.`,
        'payments.x402.assetName',
      );
    }
    if (input.assetVersion !== undefined && input.assetVersion !== canonical.version) {
      throw invalid(
        `payments.x402: assetVersion "${input.assetVersion}" is not the EIP-712 domain version ${canonical.symbol} reports on ${profile.displayName} (expected "${canonical.version}").`,
        'payments.x402.assetVersion',
      );
    }
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

/** Host only — a facilitator URL can carry a tenant path or an API key. */
function describeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '[unparseable facilitator.url]';
  }
}

/** The secret-bearing fields of an auth block, for emptiness checks only. Never logged. */
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
