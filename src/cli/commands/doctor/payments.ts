// Payment checks: where each rail settles, and whether the running gateway agrees
import {
  MPP_DEFAULT_PAYMENT_FLOW,
  MPP_PROFILE,
  MPP_SPEC_COMMIT,
  MPP_SPEC_DRAFTS,
  MPPX_VERSION,
} from '../../../payments/mpp/constants';
import type { X402FacilitatorConfig } from '../../../payments/x402/guardrails';
import {
  type CustomNetworks,
  type DeploymentMode,
  describeDeploymentMode,
  findX402Network,
  resolveDeploymentMode,
} from '../../../payments/x402/networks';
import { X402_DEFAULT_PAYMENT_FLOW } from '../../../payments/x402/payment-flow';
import type { GatewayConfig } from '../../lib/config-client';
import { PLACEHOLDER_ASSET_ADDRESS } from '../../lib/init-config';
import { maskMiddle } from '../../lib/mask';
import type { DoctorCheck, WellKnownResult } from './types';

// The rail's settlement order and how many resources override it
function describePaymentFlow(
  rail: {
    readonly paymentFlow?: string | undefined;
    readonly resourcePaymentFlows?: Readonly<Record<string, string>> | undefined;
  },
  defaultFlow: string,
): string {
  const overrides = Object.keys(rail.resourcePaymentFlows ?? {}).length;
  const overrideCount =
    overrides > 0 ? ` (${overrides} resource ${overrides === 1 ? 'override' : 'overrides'})` : '';
  return `paymentFlow=${rail.paymentFlow ?? defaultFlow}${overrideCount}`;
}

// Shared settlement fields; `payTo` holds x402 `payTo` or MPP `recipient`
interface LiveX402 {
  readonly asset: string;
  readonly network: string;
  readonly payTo: string;
}

// Result of reading a live x402 or MPP settlement block
type LiveX402Result = LiveX402 | 'disabled' | undefined;

/**
 * Extracts the effective settlement fields from the well-known document.
 * Explicit `enabled: false` is a mismatch; absent, malformed, or incomplete
 * data leaves the comparison inconclusive.
 */
function extractWellKnownX402(
  body: Record<string, unknown> | undefined,
  rail: 'x402' | 'mpp' = 'x402',
): LiveX402Result {
  const payments = body?.['payments'];
  if (typeof payments !== 'object' || payments === null) return undefined;
  const block = (payments as Record<string, unknown>)[rail];
  if (typeof block !== 'object' || block === null) return undefined;
  const rec = block as Record<string, unknown>;
  if (rec['enabled'] === false) return 'disabled';
  if (rec['enabled'] !== true) return undefined;
  const { asset, network } = rec;
  const payTo = rec[rail === 'mpp' ? 'recipient' : 'payTo'];
  if (typeof asset !== 'string' || typeof network !== 'string' || typeof payTo !== 'string') {
    return undefined;
  }
  return { asset, network, payTo };
}

// Checksum-insensitive, as config validation treats addresses
function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Compares live settlement fields with local config. A mismatch names both
 * values so the operator knows what to fix.
 */
function findX402Mismatch(
  configured: LiveX402,
  live: LiveX402,
  payToField = 'payTo',
): string | undefined {
  const diffs: string[] = [];
  if (!sameAddress(configured.asset, live.asset)) {
    diffs.push(
      `asset: gateway is using ${live.asset} but local config resolves to ${configured.asset}`,
    );
  }
  if (configured.network !== live.network) {
    diffs.push(
      `network: gateway is using "${live.network}" but local config resolves to "${configured.network}"`,
    );
  }
  if (!sameAddress(configured.payTo, live.payTo)) {
    diffs.push(
      `${payToField}: gateway is using ${live.payTo} but local config resolves to ${configured.payTo}`,
    );
  }
  if (diffs.length === 0) return undefined;
  return `${diffs.join('; ')}; the gateway may be running against an older deployment - restart it or re-run chain:deploy`;
}

/**
 * Where a rail settles and through which facilitator. `parseConfig` refuses an
 * unknown network, so an absent profile means another loader produced this
 * config, and the text says so rather than guessing.
 */
function describeSettlement(
  network: string,
  facilitator: X402FacilitatorConfig,
  customNetworks?: CustomNetworks,
): { readonly mode: DeploymentMode | undefined; readonly where: string; readonly via: string } {
  const profile = findX402Network(network, customNetworks);
  const mode = profile ? resolveDeploymentMode(profile) : undefined;
  const where =
    profile === undefined || mode === undefined
      ? `unknown network ${network}`
      : mode === 'local'
        ? `LOCAL dev chain (${network})`
        : `${describeDeploymentMode(mode)} on ${profile.displayName} (${network})`;
  const via =
    facilitator.mode === 'local' ? 'local (in-process)' : `remote (auth=${facilitator.auth.type})`;
  return { mode, where, via };
}

// Reports rather than re-checks: config load already enforced every guardrail
// (src/payments/x402/guardrails.ts, shared by x402 and MPP). An operator about
// to move real money sees which guarantees they rely on, including an
// unauthenticated facilitator the config accepted through
// `allowUnauthenticatedFacilitator`.
function mainnetSafetyCheck(
  name: string,
  payToField: 'payTo' | 'recipient',
  facilitator: X402FacilitatorConfig,
): DoctorCheck {
  const unauthenticated = facilitator.mode === 'remote' && facilitator.auth.type === 'none';
  return {
    name,
    status: unauthenticated ? 'WARN' : 'INFO',
    detail: unauthenticated
      ? `${describeDeploymentMode('mainnet')}: no credential is sent to the remote facilitator ` +
        '(accepted via allowUnauthenticatedFacilitator); its anonymous-access ' +
        'limits apply. Config load also requires ' +
        `allowMainnet, HTTPS, a non-development ${payToField} and the canonical asset. ` +
        'Payments fail closed.'
      : `${describeDeploymentMode('mainnet')}. Enforced at config load: explicit allowMainnet ` +
        `opt-in, remote facilitator over HTTPS with a credential, non-development ${payToField}, ` +
        'and the canonical asset for this network. Payments fail closed.',
  };
}

// x402 and MPP, each compared with what the running gateway reports
export function paymentChecks(
  config: GatewayConfig | undefined,
  wellKnown: WellKnownResult | undefined,
  gatewayUrl: string,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  // 6. Payments
  const x402 = config?.payments.x402;
  if (x402 === undefined || !x402.enabled) {
    checks.push({ name: 'Payments', status: 'INFO', detail: 'x402 not configured' });
  } else {
    const { mode, where, via } = describeSettlement(x402.network, x402.facilitator, x402.networks);
    const flow = describePaymentFlow(x402, X402_DEFAULT_PAYMENT_FLOW);
    const summary = `x402 v2 (scheme=exact) enabled - ${where}, destination=${maskMiddle(x402.payTo)}, facilitator=${via}, ${flow}`;
    const live = wellKnown?.ok ? extractWellKnownX402(wellKnown.body) : undefined;
    if (sameAddress(x402.asset, PLACEHOLDER_ASSET_ADDRESS)) {
      // `init` writes this placeholder, and the live cross-check below would
      // pass it, since the gateway echoes the same config. No token contract
      // exists there, so every paid call fails (closed, with no funds at
      // risk).
      checks.push({
        name: 'Payments',
        status: 'WARN',
        detail: `${summary}, but the asset is still the init placeholder ${maskMiddle(PLACEHOLDER_ASSET_ADDRESS)}. No token contract exists there, so every paid call will fail. Set payments.x402.asset (\${X402_ASSET} is filled from .deploy/local.json, which "npm run chain:deploy" writes)`,
      });
    } else if (live === 'disabled') {
      // Verified, and it disagrees: the gateway runs a different configuration
      checks.push({
        name: 'Payments',
        status: 'FAIL',
        detail: `${summary}, but the gateway at ${gatewayUrl} reports x402 disabled, so it is running a different configuration`,
      });
    } else if (live === undefined) {
      // Gateway unreachable, or the document does not say: a match cannot be
      // judged either way, so INFO rather than FAIL
      checks.push({
        name: 'Payments',
        status: 'INFO',
        detail: `${summary} (gateway's live settlement config could not be verified)`,
      });
    } else {
      const mismatch = findX402Mismatch(x402, live);
      checks.push(
        mismatch === undefined
          ? { name: 'Payments', status: 'PASS', detail: summary }
          : { name: 'Payments', status: 'FAIL', detail: mismatch },
      );
    }
    if (mode === 'mainnet') {
      checks.push(mainnetSafetyCheck('Mainnet safety', 'payTo', x402.facilitator));
    }
  }
  const mpp = config?.payments.mpp;
  if (mpp === undefined || !mpp.enabled) {
    checks.push({ name: 'Payments (MPP)', status: 'INFO', detail: 'MPP not configured' });
  } else {
    const { mode, where, via } = describeSettlement(mpp.network, mpp.facilitator);
    const summary =
      `MPP ${MPP_PROFILE.intent}/${MPP_PROFILE.method}/${MPP_PROFILE.credentialType} enabled - ` +
      `${where}, asset=${MPP_PROFILE.assetSymbol} ${maskMiddle(mpp.asset)}, ` +
      `recipient=${maskMiddle(mpp.recipient)}, facilitator=${via}, ` +
      `${describePaymentFlow(mpp, MPP_DEFAULT_PAYMENT_FLOW)}, ` +
      `spec ${MPP_SPEC_DRAFTS.core}@${MPP_SPEC_COMMIT.slice(0, 7)}, mppx ${MPPX_VERSION}`;
    const configured = { asset: mpp.asset, network: mpp.network, payTo: mpp.recipient };
    const live = wellKnown?.ok ? extractWellKnownX402(wellKnown.body, 'mpp') : undefined;
    if (live === 'disabled') {
      checks.push({
        name: 'Payments (MPP)',
        status: 'FAIL',
        detail: `Local config enables MPP, but ${gatewayUrl} reports it disabled`,
      });
    } else if (live === undefined) {
      checks.push({
        name: 'Payments (MPP)',
        status: 'INFO',
        detail: `${summary} (live MPP settlement config unavailable for comparison)`,
      });
    } else {
      const mismatch = findX402Mismatch(configured, live, 'recipient');
      checks.push(
        mismatch === undefined
          ? { name: 'Payments (MPP)', status: 'PASS', detail: summary }
          : { name: 'Payments (MPP)', status: 'FAIL', detail: mismatch },
      );
    }
    if (mode === 'mainnet') {
      checks.push(mainnetSafetyCheck('Mainnet safety (MPP)', 'recipient', mpp.facilitator));
    }
  }
  return checks;
}
