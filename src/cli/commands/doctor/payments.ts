// Payment checks: where each rail settles, and whether the running gateway agrees

import { isRecord } from '../../../core/is-record';
import {
  MPP_DEFAULT_PAYMENT_FLOW,
  MPP_PROFILE,
  MPP_SPEC_COMMIT,
  MPP_SPEC_DRAFTS,
  MPPX_VERSION,
} from '../../../payments/mpp/constants';
import { sameAddress } from '../../../payments/x402/addresses';
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

// One offer's public settlement terms; `payTo` holds x402 `payTo` or MPP `recipient`
interface RailOffer {
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  readonly assetDecimals?: number;
  /** Absent for EIP-3009 and for every non-EVM offer */
  readonly assetTransferMethod?: string;
  /** The live offer's health status, when the gateway publishes it */
  readonly status?: string;
}

// A rail's terms, as configured or as the running gateway publishes them
interface RailTerms {
  readonly offers: readonly RailOffer[];
  /** Resources with their own offers, by id */
  readonly resourceOffers?: Readonly<Record<string, readonly RailOffer[]>>;
  /** Absent from a gateway that does not publish its flows */
  readonly paymentFlow?: string;
  readonly resourcePaymentFlows?: Readonly<Record<string, string>>;
}

// Result of reading a live x402 or MPP block
type LiveRailResult = RailTerms | 'disabled' | undefined;

function readOffer(rec: Record<string, unknown>, rail: 'x402' | 'mpp'): RailOffer | undefined {
  const { asset, network, assetDecimals, assetTransferMethod, status } = rec;
  const payTo = rec[rail === 'mpp' ? 'recipient' : 'payTo'];
  if (typeof asset !== 'string' || typeof network !== 'string' || typeof payTo !== 'string') {
    return undefined;
  }
  return {
    network,
    asset,
    payTo,
    ...(typeof assetDecimals === 'number' ? { assetDecimals } : {}),
    ...(typeof assetTransferMethod === 'string' ? { assetTransferMethod } : {}),
    ...(typeof status === 'string' ? { status } : {}),
  };
}

// A list of offers, or undefined when any entry is malformed
function readOffers(value: unknown, rail: 'x402' | 'mpp'): RailOffer[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const read = value.map((entry) => (isRecord(entry) ? readOffer(entry, rail) : undefined));
  return read.some((offer) => offer === undefined) ? undefined : (read as RailOffer[]);
}

/**
 * Reads offers and flows from discovery. Explicit `enabled: false` signals
 * a mismatch; missing or invalid offer data leaves comparison inconclusive.
 */
function extractLiveRail(
  body: Record<string, unknown> | undefined,
  rail: 'x402' | 'mpp' = 'x402',
): LiveRailResult {
  const block = isRecord(body?.['payments']) ? body['payments'][rail] : undefined;
  if (!isRecord(block)) return undefined;
  if (block['enabled'] === false) return 'disabled';
  if (block['enabled'] !== true) return undefined;
  const first = readOffer(block, rail);
  if (first === undefined) return undefined;
  // The block's own fields repeat the first offer; `options` lists them all
  let offers: readonly RailOffer[] = [first];
  if (block['options'] !== undefined) {
    const listed = readOffers(block['options'], rail);
    if (listed === undefined) return undefined;
    offers = listed;
  }
  let resourceOffers: Record<string, readonly RailOffer[]> | undefined;
  const ownLists = block['resourceOptions'];
  if (ownLists !== undefined) {
    if (!isRecord(ownLists)) return undefined;
    resourceOffers = {};
    for (const [id, list] of Object.entries(ownLists)) {
      const read = readOffers(list, rail);
      if (read === undefined) return undefined;
      resourceOffers[id] = read;
    }
  }
  const { paymentFlow, resourcePaymentFlows } = block;
  return {
    offers,
    ...(resourceOffers !== undefined ? { resourceOffers } : {}),
    ...(typeof paymentFlow === 'string' ? { paymentFlow } : {}),
    ...(isRecord(resourcePaymentFlows)
      ? {
          resourcePaymentFlows: Object.fromEntries(
            Object.entries(resourcePaymentFlows).map(([id, flow]) => [id, String(flow)]),
          ),
        }
      : {}),
  };
}

function describeOverrides(flows: Readonly<Record<string, string>> | undefined): string {
  const entries = Object.entries(flows ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return entries.length > 0 ? entries.map(([id, flow]) => `${id}=${flow}`).join(', ') : 'none';
}

/**
 * Compares offers in challenge order, then published flows, with local config.
 * Mismatches name both values for the operator.
 */
function findRailMismatch(
  configured: RailTerms,
  live: RailTerms,
  payToField = 'payTo',
  customNetworks?: CustomNetworks,
): string | undefined {
  const diffs: string[] = [];
  const differ = (field: string, liveValue: unknown, localValue: unknown) =>
    diffs.push(
      `${field}: gateway is using ${liveValue} but local config resolves to ${localValue}`,
    );
  const compareOffers = (
    label: string,
    localOffers: readonly RailOffer[],
    liveOffers: readonly RailOffer[],
  ) => {
    if (liveOffers.length !== localOffers.length) {
      differ(label, `${liveOffers.length} offer(s)`, localOffers.length);
      return;
    }
    localOffers.forEach((local, index) => {
      const remote = liveOffers[index] as RailOffer;
      const prefix =
        label !== 'options'
          ? `${label}[${index}] `
          : localOffers.length > 1
            ? `option ${index} `
            : '';
      // EVM addresses compare without case; Solana's and NEAR's compare exactly
      const profile = findX402Network(local.network, customNetworks);
      const same = (a: string, b: string) => (profile ? sameAddress(profile, a, b) : a === b);
      if (local.network !== remote.network) {
        differ(`${prefix}network`, `"${remote.network}"`, `"${local.network}"`);
      }
      if (!same(local.asset, remote.asset)) differ(`${prefix}asset`, remote.asset, local.asset);
      if (!same(local.payTo, remote.payTo)) {
        differ(`${prefix}${payToField}`, remote.payTo, local.payTo);
      }
      if (
        local.assetDecimals !== undefined &&
        remote.assetDecimals !== undefined &&
        local.assetDecimals !== remote.assetDecimals
      ) {
        differ(`${prefix}assetDecimals`, remote.assetDecimals, local.assetDecimals);
      }
      if (local.assetTransferMethod !== remote.assetTransferMethod) {
        differ(
          `${prefix}assetTransferMethod`,
          remote.assetTransferMethod ?? 'eip3009',
          local.assetTransferMethod ?? 'eip3009',
        );
      }
    });
  };
  compareOffers('options', configured.offers, live.offers);
  const localLists = configured.resourceOffers ?? {};
  const liveLists = live.resourceOffers ?? {};
  for (const id of [...new Set([...Object.keys(localLists), ...Object.keys(liveLists)])].sort()) {
    compareOffers(`resources.${id}.x402.accepts`, localLists[id] ?? [], liveLists[id] ?? []);
  }
  // A gateway that publishes no flows cannot be compared on them
  if (live.paymentFlow !== undefined) {
    if (live.paymentFlow !== configured.paymentFlow) {
      differ('paymentFlow', live.paymentFlow, configured.paymentFlow);
    }
    const liveOverrides = describeOverrides(live.resourcePaymentFlows);
    const localOverrides = describeOverrides(configured.resourcePaymentFlows);
    if (liveOverrides !== localOverrides)
      differ('resourcePaymentFlows', liveOverrides, localOverrides);
  }
  return diffs.length === 0 ? undefined : diffs.join('; ');
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
  networks: readonly string[],
): DoctorCheck {
  const unauthenticated = facilitator.mode === 'remote' && facilitator.auth.type === 'none';
  const where = `${describeDeploymentMode('mainnet')} on ${networks.join(', ')}`;
  return {
    name,
    status: unauthenticated ? 'WARN' : 'INFO',
    detail: unauthenticated
      ? `${where}: no credential is sent to the remote facilitator ` +
        '(accepted via allowUnauthenticatedFacilitator); its anonymous-access ' +
        'limits apply. Config load also requires ' +
        `allowMainnet, HTTPS, a non-development ${payToField} and the canonical asset. ` +
        'Payments fail closed.'
      : `${where}. Enforced at config load: explicit allowMainnet ` +
        `opt-in, remote facilitator over HTTPS with a credential, non-development ${payToField}, ` +
        'and the canonical asset of each network. Payments fail closed.',
  };
}

function railOffer(option: {
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  readonly assetDecimals: number;
  readonly assetTransferMethod?: string;
}): RailOffer {
  const { network, asset, payTo, assetDecimals, assetTransferMethod } = option;
  return {
    network,
    asset,
    payTo,
    assetDecimals,
    ...(assetTransferMethod !== undefined ? { assetTransferMethod } : {}),
  };
}

// Discovery exposes offer statuses; reasons stay in gateway debug logs
function offerHealthCheck(
  live: RailTerms,
  named: (network: string) => string,
): DoctorCheck | undefined {
  const all = [...live.offers, ...Object.values(live.resourceOffers ?? {}).flat()];
  const offers = [
    ...new Map(
      all.map((offer) => [`${offer.network} ${offer.asset} ${offer.payTo}`, offer]),
    ).values(),
  ];
  const reported = offers.filter((offer) => offer.status !== undefined);
  if (reported.length === 0) return undefined;
  const failing = reported.filter((offer) => offer.status === 'fail');
  const degraded = reported.filter((offer) => offer.status === 'warn');
  const describe = (list: readonly RailOffer[]) =>
    list
      .map(
        (offer) =>
          `${named(offer.network)} ${maskMiddle(offer.asset)} to ${maskMiddle(offer.payTo)}`,
      )
      .join('; ');
  if (failing.length === 0 && degraded.length === 0) {
    return {
      name: 'Payments (offers)',
      status: 'PASS',
      detail: `${reported.length} offer(s) pass their health checks`,
    };
  }
  const problems = [
    ...(failing.length > 0 ? [`failing: ${describe(failing)}`] : []),
    ...(degraded.length > 0 ? [`degraded: ${describe(degraded)}`] : []),
  ];
  return {
    name: 'Payments (offers)',
    status: failing.length > 0 ? 'FAIL' : 'WARN',
    detail: `${problems.join('; ')}. The gateway logs each reason at debug level`,
  };
}

// x402 and MPP, each compared with what the running gateway reports
export function paymentChecks(
  config: GatewayConfig | undefined,
  wellKnown: WellKnownResult | undefined,
  gatewayUrl: string,
  chainDeploy = false,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  // Suggest the repository deployment script only when the caller found it
  const stale = `; the gateway may be running against an older deployment - restart it${chainDeploy ? ' or re-run chain:deploy' : ''}`;
  // 6. Payments
  const x402 = config?.payments.x402;
  if (x402 === undefined || !x402.enabled) {
    checks.push({ name: 'Payments', status: 'INFO', detail: 'x402 not configured' });
  } else {
    const options = x402.options ?? [x402];
    const resourceOptions = x402.resourceOptions ?? {};
    // Every configured offer, the rail's and each resource's
    const everyOption = [...options, ...Object.values(resourceOptions).flat()];
    const { mode, where, via } = describeSettlement(x402.network, x402.facilitator, x402.networks);
    const flow = describePaymentFlow(x402, X402_DEFAULT_PAYMENT_FLOW);
    const named = (network: string) =>
      `${findX402Network(network, x402.networks)?.displayName ?? 'unknown network'} (${network})`;
    const terms =
      options.length === 1
        ? `${where}, destination=${maskMiddle(x402.payTo)}`
        : `${mode !== undefined ? describeDeploymentMode(mode) : 'unknown mode'}, ${options.length} options: ` +
          options
            .map((option) => `${named(option.network)} to ${maskMiddle(option.payTo)}`)
            .join('; ');
    const ownCount = Object.keys(resourceOptions).length;
    const own =
      ownCount > 0
        ? `, ${ownCount} resource${ownCount === 1 ? '' : 's'} with ${ownCount === 1 ? 'its' : 'their'} own offers`
        : '';
    const summary = `x402 v2 (scheme=exact) enabled - ${terms}${own}, facilitator=${via}, ${flow}`;
    const live = wellKnown?.ok ? extractLiveRail(wellKnown.body) : undefined;
    const placeholder = PLACEHOLDER_ASSET_ADDRESS.toLowerCase();
    if (everyOption.some((option) => option.asset.toLowerCase() === placeholder)) {
      // Matching live and local config does not establish that a placeholder
      // address has a token contract
      checks.push({
        name: 'Payments',
        status: 'WARN',
        detail: `${summary}, but at least one offer uses the init placeholder ${maskMiddle(PLACEHOLDER_ASSET_ADDRESS)}. Set that offer's asset to its token contract address${chainDeploy ? ' (${X402_ASSET} is filled from .deploy/local.json, which "npm run chain:deploy" writes)' : ''}`,
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
      const configured: RailTerms = {
        offers: options.map(railOffer),
        ...(ownCount > 0
          ? {
              resourceOffers: Object.fromEntries(
                Object.entries(resourceOptions).map(([id, list]) => [id, list.map(railOffer)]),
              ),
            }
          : {}),
        paymentFlow: x402.paymentFlow ?? X402_DEFAULT_PAYMENT_FLOW,
        ...(x402.resourcePaymentFlows !== undefined
          ? { resourcePaymentFlows: x402.resourcePaymentFlows }
          : {}),
      };
      const mismatch = findRailMismatch(configured, live, 'payTo', x402.networks);
      checks.push(
        mismatch === undefined
          ? { name: 'Payments', status: 'PASS', detail: summary }
          : { name: 'Payments', status: 'FAIL', detail: `${mismatch}${stale}` },
      );
      const offerHealth = offerHealthCheck(live, named);
      if (offerHealth !== undefined) checks.push(offerHealth);
    }
    if (mode === 'mainnet') {
      checks.push(
        mainnetSafetyCheck('Mainnet safety', 'payTo', x402.facilitator, [
          ...new Set(everyOption.map((option) => named(option.network))),
        ]),
      );
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
    const configured: RailTerms = {
      offers: [
        {
          network: mpp.network,
          asset: mpp.asset,
          payTo: mpp.recipient,
          assetDecimals: MPP_PROFILE.assetDecimals,
        },
      ],
      paymentFlow: mpp.paymentFlow ?? MPP_DEFAULT_PAYMENT_FLOW,
      ...(mpp.resourcePaymentFlows !== undefined
        ? { resourcePaymentFlows: mpp.resourcePaymentFlows }
        : {}),
    };
    const live = wellKnown?.ok ? extractLiveRail(wellKnown.body, 'mpp') : undefined;
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
      const mismatch = findRailMismatch(configured, live, 'recipient');
      checks.push(
        mismatch === undefined
          ? { name: 'Payments (MPP)', status: 'PASS', detail: summary }
          : { name: 'Payments (MPP)', status: 'FAIL', detail: `${mismatch}${stale}` },
      );
    }
    if (mode === 'mainnet') {
      checks.push(
        mainnetSafetyCheck('Mainnet safety (MPP)', 'recipient', mpp.facilitator, [
          `${findX402Network(mpp.network)?.displayName ?? 'unknown network'} (${mpp.network})`,
        ]),
      );
    }
  }
  return checks;
}
