import { accessSync, existsSync, constants as fsConstants } from 'node:fs';
import { dirname } from 'node:path';
import picocolors from 'picocolors';
// Constants and a descriptor only: the AP2 provider would pull the optional
// peers `jose`, `@sd-jwt/core` and `canonicalize` into the CLI bundle
import {
  AP2_CHECKOUT_MANDATE_VCT,
  AP2_CHECKOUT_PROFILE,
  AP2_SPEC_VERSION,
} from '../../authorization/ap2/constants';
import { AP2_UNSUPPORTED } from '../../authorization/ap2/descriptor';
import { type CommerceResource, isCommerceError, type ReceiptStore } from '../../core';
import { extractPathParameterNames } from '../../core/execution';
import {
  MPP_PROFILE,
  MPP_SPEC_COMMIT,
  MPP_SPEC_DRAFTS,
  MPPX_VERSION,
} from '../../payments/mpp/constants';
import type { X402FacilitatorConfig } from '../../payments/x402/guardrails';
import {
  type DeploymentMode,
  describeDeploymentMode,
  findNetworkProfile,
  resolveDeploymentMode,
} from '../../payments/x402/networks';
// Narrow modules, not the protocol barrels: the CLI must pull in no protocol SDK
import {
  A2A_AGENT_CARD_PATH,
  A2A_PROTOCOL_BINDING,
  A2A_PROTOCOL_VERSION,
  A2A_SPEC_VERSION,
} from '../../protocols/a2a/constants';
import { A2A_UNSUPPORTED } from '../../protocols/a2a/descriptor';
import {
  ACP_API_VERSION,
  ACP_SPEC_VERSION,
  ACP_WELL_KNOWN_PATH,
} from '../../protocols/acp/constants';
import { ACP_UNSUPPORTED } from '../../protocols/acp/descriptor';
import { createSqliteReceiptStore } from '../../storage/receipts';
import { type ConfigLoader, type GatewayConfig, loadConfigDynamic } from '../lib/config-client';
import { type FetchLike, fetchJson } from '../lib/http';
import { PLACEHOLDER_ASSET_ADDRESS } from '../lib/init-config';
import type { Io } from '../lib/io';
import {
  fillEnvFromLocalChainManifest,
  LOCAL_CHAIN_MANIFEST_PATH,
  MANIFEST_FILLABLE_ENV_VAR_NAMES,
  type ManifestEnvFill,
} from '../lib/manifest-env';
import { maskMiddle } from '../lib/mask';
import { readVersionReport } from '../lib/versions';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'INFO';

export interface DoctorCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly score: { readonly passed: number; readonly total: number };
  readonly exitCode: number;
}

export interface DoctorOptions {
  readonly configPath?: string;
  readonly gatewayUrl?: string;
}

export interface DoctorDeps {
  readonly fetchImpl?: FetchLike;
  readonly loadConfig?: ConfigLoader;
  readonly createStore?: (path: string) => ReceiptStore;
  readonly fillEnvFromManifest?: (env: NodeJS.ProcessEnv) => ManifestEnvFill;
}

const CHECK_TIMEOUT_MS = 1500;

function deriveGatewayUrl(explicit: string | undefined, config: GatewayConfig | undefined): string {
  if (explicit !== undefined) return explicit.replace(/\/$/, '');
  if (config !== undefined) {
    // `0.0.0.0` and `::` mean all interfaces, so probe loopback. An IPv6
    // literal such as `::1` must be bracketed, or the URL is invalid
    // (`http://::1:8080`).
    const raw = config.server.host;
    const host = raw === '0.0.0.0' ? '127.0.0.1' : raw === '::' ? '::1' : raw;
    const authority = host.includes(':') ? `[${host}]` : host;
    return `http://${authority}:${config.server.port}`;
  }
  return 'http://localhost:8080';
}

/**
 * Fills `{param}` slots with a probe value, using the runtime's own grammar
 * (`extractPathParameterNames`). A looser local pattern would fill a token the
 * runtime leaves literal, such as `{report id}`, and report the backend
 * reachable at a URL no real request uses. Unrecognized tokens stay as they
 * are, so the probe hits what the gateway would send.
 */
function substitutePathParams(url: string): string {
  let filled = url;
  for (const name of extractPathParameterNames(url)) {
    filled = filled.replaceAll(`{${name}}`, 'demo-check');
  }
  return filled;
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
 * Where a rail settles and through which facilitator. Chain id 84532 is both
 * the local dev chain and public Base Sepolia, so the deployment mode (network
 * plus facilitator) says which one this is. Local mode names the public
 * network only as sharing its chain id, never as the place of settlement.
 * `parseConfig` refuses an unknown network, so an absent profile means another
 * loader produced this config, and the text says so rather than guessing.
 */
function describeSettlement(
  network: string,
  facilitator: X402FacilitatorConfig,
): { readonly mode: DeploymentMode | undefined; readonly where: string; readonly via: string } {
  const profile = findNetworkProfile(network);
  const mode = profile ? resolveDeploymentMode(profile, facilitator.mode) : undefined;
  const where =
    profile === undefined || mode === undefined
      ? `unknown network ${network}`
      : mode === 'local'
        ? `LOCAL dev chain (${network}, chain id shared with ${profile.displayName})`
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

// Issuer ids and how many keys each carries. Never a key
function describeIssuers(
  label: string,
  issuers: readonly { readonly issuer: string; readonly keys: readonly unknown[] }[],
): string {
  const described = issuers
    .map(
      (entry) => `${entry.issuer} (${entry.keys.length} key${entry.keys.length === 1 ? '' : 's'})`,
    )
    .join(', ');
  return `${label} issuers: ${described}`;
}

// Whether an existing file is writable, without creating one
function isWritableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// A SQLite store file, diagnosed without creating it (see the Storage check in
// `runDoctor`). `suffix` is appended to every detail.
function storeFileCheck(
  name: string,
  path: string,
  risk: { readonly inMemory: string; readonly unwritable: string },
  suffix = '',
): DoctorCheck {
  if (path === ':memory:') {
    return {
      name,
      status: 'WARN',
      detail: `in-memory store: ${risk.inMemory}; use a file path in production${suffix}`,
    };
  }
  if (existsSync(path)) {
    return isWritableFile(path)
      ? { name, status: 'PASS', detail: `writable at "${path}"${suffix}` }
      : {
          name,
          status: 'FAIL',
          detail: `"${path}" exists but is not writable by this user, so ${risk.unwritable}${suffix}`,
        };
  }
  return { name, status: 'WARN', detail: `${missingStoreDetail(path)}${suffix}` };
}

// Every SQLite store opens through `openSqliteDatabase`, which creates the file
// and a missing directory, so one wording covers them all
function missingStoreDetail(path: string): string {
  const directory = dirname(path);
  return directory !== '.' && !existsSync(directory)
    ? `no store at "${path}" and its directory does not exist. Both are created when the gateway starts, provided the path is writable`
    : `no store at "${path}" yet. It is created the first time the gateway starts`;
}

/**
 * The resource mapped to each checkout operation, re-checked against the rules
 * config enforces: present, acp-exposed and free to invoke. Resource ids are
 * printed because an operator needs them to fix a mapping; the mapping is
 * config, not a secret.
 */
function acpMappingCheck(
  config: GatewayConfig,
  operations: Readonly<Record<string, string>>,
): DoctorCheck {
  const byId = new Map(config.resources.map((resource) => [resource.id, resource]));
  const problems: string[] = [];

  for (const [operation, resourceId] of Object.entries(operations)) {
    const resource = byId.get(resourceId);
    if (resource === undefined) {
      problems.push(`${operation} -> "${resourceId}" does not exist`);
      continue;
    }
    if (!resource.exposedVia.includes('acp')) {
      problems.push(`${operation} -> "${resourceId}" is not exposed via acp`);
    }
    // ACP checkout carries the merchant's own purchase payment; charging for
    // the invocation as well would put two payment layers on one call
    if (resource.pricing.type !== 'free' || resource.paymentMethods.length > 0) {
      problems.push(`${operation} -> "${resourceId}" is not free to invoke`);
    }
  }

  if (problems.length > 0) {
    return { name: 'ACP checkout mapping', status: 'FAIL', detail: problems.join('; ') };
  }
  return {
    name: 'ACP checkout mapping',
    status: 'PASS',
    detail: `5 operations mapped to free acp-exposed resources (${Object.values(operations).join(', ')})`,
  };
}

/** `agent-commerce doctor [--config] [--gateway] [--json]` */
export async function runDoctor(
  options: DoctorOptions,
  deps: DoctorDeps = {},
): Promise<DoctorReport> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const loadConfig = deps.loadConfig ?? loadConfigDynamic;
  const createStore = deps.createStore ?? ((path: string) => createSqliteReceiptStore({ path }));
  const fillEnvFromManifest = deps.fillEnvFromManifest ?? fillEnvFromLocalChainManifest;

  const checks: DoctorCheck[] = [];
  let config: GatewayConfig | undefined;

  // 1. Config
  const { env, filled, manifestFound } = fillEnvFromManifest(process.env);
  const filledSuffix =
    filled.length > 0
      ? ` (using local chain manifest ${LOCAL_CHAIN_MANIFEST_PATH} for ${filled.join(', ')})`
      : '';
  try {
    config = await loadConfig({
      ...(options.configPath !== undefined ? { path: options.configPath } : {}),
      env,
    });
    checks.push({
      name: 'Config',
      status: 'PASS',
      detail: `valid: ${config.resources.length} resource(s), merchant "${config.merchant.name}"${filledSuffix}`,
    });
  } catch (err) {
    const variable = isCommerceError(err) ? err.details?.['variable'] : undefined;
    const hint =
      !manifestFound &&
      typeof variable === 'string' &&
      MANIFEST_FILLABLE_ENV_VAR_NAMES.has(variable)
        ? `. Run "npm run chain:deploy": it writes ${LOCAL_CHAIN_MANIFEST_PATH}, which fills local X402_*/MERCHANT_WALLET placeholders automatically`
        : '';
    checks.push({
      name: 'Config',
      status: 'FAIL',
      detail: `${err instanceof Error ? err.message : String(err)}${hint}`,
    });
  }

  const gatewayUrl = deriveGatewayUrl(options.gatewayUrl, config);

  // 2. Gateway
  const health = await fetchJson(fetchImpl, `${gatewayUrl}/health`, CHECK_TIMEOUT_MS);
  let gatewayUp = false;
  if (!health.ok) {
    checks.push({
      name: 'Gateway',
      status: 'FAIL',
      detail: `unreachable at ${gatewayUrl} (${health.error ?? `HTTP ${health.status}`})`,
    });
  } else {
    gatewayUp = true;
    const ready = await fetchJson(fetchImpl, `${gatewayUrl}/ready`, CHECK_TIMEOUT_MS);
    checks.push(
      ready.ok
        ? { name: 'Gateway', status: 'PASS', detail: `healthy and ready at ${gatewayUrl}` }
        : {
            name: 'Gateway',
            status: 'WARN',
            detail: `healthy but not ready at ${gatewayUrl} (${ready.error ?? `HTTP ${ready.status}`})`,
          },
    );
  }

  // 3. Backend(s)
  if (config === undefined) {
    checks.push({ name: 'Backend', status: 'WARN', detail: 'skipped: config invalid' });
  } else if (config.resources.length === 0) {
    checks.push({ name: 'Backend', status: 'INFO', detail: 'no resources configured' });
  } else {
    const resources = config.resources as readonly CommerceResource[];
    const urls: string[] = [...new Set(resources.map((r) => substitutePathParams(r.handler.url)))];
    const results = await Promise.all(
      urls.map((url) => fetchJson(fetchImpl, url, CHECK_TIMEOUT_MS)),
    );
    const reachable = results.filter((r) => r.status !== 0).length;
    const status: CheckStatus =
      reachable === urls.length ? 'PASS' : reachable === 0 ? 'FAIL' : 'WARN';
    checks.push({
      name: 'Backend',
      status,
      detail: `${reachable}/${urls.length} backend host(s) reachable`,
    });
  }

  // 4. Well-known document (feeds Protocols + Protocol versions)
  const wellKnown = gatewayUp
    ? await fetchJson<Record<string, unknown>>(
        fetchImpl,
        `${gatewayUrl}/.well-known/agent-commerce`,
        CHECK_TIMEOUT_MS,
      )
    : undefined;

  // 5. Protocols
  if (config === undefined) {
    checks.push({ name: 'Protocols', status: 'WARN', detail: 'skipped: config invalid' });
  } else if (wellKnown === undefined || !wellKnown.ok) {
    checks.push({ name: 'Protocols', status: 'FAIL', detail: 'well-known document unreachable' });
  } else {
    const mcpMountPath = config.protocols.mcp.enabled ? config.protocols.mcp.mountPath : undefined;
    const a2aMountPath = config.protocols.a2a.enabled ? config.protocols.a2a.mountPath : undefined;
    checks.push({
      name: 'Protocols',
      status: 'PASS',
      detail: `http=${config.protocols.http.enabled ? 'on' : 'off'} mcp=${config.protocols.mcp.enabled ? `on (${mcpMountPath})` : 'off'} a2a=${config.protocols.a2a.enabled ? `on (${a2aMountPath})` : 'off'} acp=${config.protocols.acp.enabled ? `on (${config.protocols.acp.mountPath})` : 'off'}`,
    });
  }

  // 5b. A2A specifics, from the pins rather than the live gateway. The spec
  // revision and the negotiation version look alike, so each is named.
  if (config === undefined) {
    checks.push({ name: 'A2A', status: 'WARN', detail: 'skipped: config invalid' });
  } else if (!config.protocols.a2a.enabled) {
    checks.push({ name: 'A2A', status: 'INFO', detail: 'disabled' });
  } else {
    checks.push({
      name: 'A2A',
      status: 'PASS',
      detail: `experimental · spec ${A2A_SPEC_VERSION} · protocol ${A2A_PROTOCOL_VERSION} · binding ${A2A_PROTOCOL_BINDING} · mount ${config.protocols.a2a.mountPath} · card ${A2A_AGENT_CARD_PATH}`,
    });
    // Listed in full, as are ACP's and AP2's below: a count does not tell an
    // operator whether the one feature their client needs is missing
    checks.push({
      name: 'A2A unsupported',
      status: 'INFO',
      detail: A2A_UNSUPPORTED.join(', '),
    });
  }

  // 5c. ACP specifics, from config and the pins: the well-known document omits
  // the bearer token, the idempotency path and the operation mapping. This
  // report prints the path and the mapping, never the token.
  if (config === undefined) {
    checks.push({ name: 'ACP', status: 'WARN', detail: 'skipped: config invalid' });
  } else if (!config.protocols.acp.enabled) {
    checks.push({ name: 'ACP', status: 'INFO', detail: 'disabled' });
  } else {
    const acp = config.protocols.acp;
    checks.push({
      name: 'ACP',
      status: 'PASS',
      detail: `experimental · spec ${ACP_SPEC_VERSION} · API-Version ${ACP_API_VERSION} · service checkout · mount ${acp.mountPath} · discovery ${ACP_WELL_KNOWN_PATH}`,
    });

    // Whether a token is configured and its length, never the token. Config
    // refuses an empty one.
    checks.push({
      name: 'ACP auth',
      status: 'PASS',
      detail: `bearer token configured (${acp.auth.token.length} characters, not shown)`,
    });

    checks.push(
      storeFileCheck(
        'ACP idempotency',
        acp.idempotency.path,
        {
          inMemory: 'replay protection is lost on every restart',
          unwritable: 'the adapter cannot claim idempotency keys',
        },
        ` (retention ${acp.idempotency.retentionHours}h)`,
      ),
    );
    checks.push(acpMappingCheck(config, acp.checkout.operations));

    checks.push({
      name: 'ACP unsupported',
      status: 'INFO',
      detail: ACP_UNSUPPORTED.join(', '),
    });
  }

  // 5d. AP2 authorization, from config and the pins. Verification keys are
  // public but still trust policy nobody asked this report to print, so only
  // issuer ids and key counts appear.
  const ap2 = config?.authorization?.ap2;
  if (config === undefined) {
    checks.push({ name: 'AP2', status: 'WARN', detail: 'skipped: config invalid' });
  } else if (ap2 === undefined || !ap2.enabled) {
    checks.push({ name: 'AP2', status: 'INFO', detail: 'disabled' });
  } else {
    checks.push({
      name: 'AP2',
      status: 'PASS',
      detail: `experimental · spec ${AP2_SPEC_VERSION} · mode ${ap2.mode} · ${AP2_CHECKOUT_MANDATE_VCT} · profile ${AP2_CHECKOUT_PROFILE} · clock skew ${ap2.clockSkewSeconds}s · mandate aud ${ap2.requireMandateAudience === true ? 'required' : 'optional'} · mandate exp ${ap2.requireMandateExpiry === true ? 'required' : 'optional'}`,
    });

    // Two lists, reported separately: signing the merchant's checkout
    // documents must not read as the power to issue mandates
    checks.push({
      name: 'AP2 trust',
      status: 'PASS',
      detail: `${describeIssuers('mandate', ap2.trust.mandateIssuers)} · ${describeIssuers('checkout', ap2.trust.checkoutIssuers)}`,
    });

    checks.push(
      storeFileCheck('AP2 replay store', ap2.replay.path, {
        inMemory:
          'every spent mandate is forgotten on restart, so one could authorize a second purchase',
        unwritable: 'no mandate could be recorded as spent',
      }),
    );

    // Resource ids, so an operator can see exactly which purchases now need a
    // mandate. An empty list means AP2 is configured and gating nothing.
    const gated = config.resources.filter((resource) =>
      resource.authorization?.required.includes('ap2'),
    );
    checks.push({
      name: 'AP2 resources',
      status: gated.length > 0 ? 'PASS' : 'WARN',
      detail:
        gated.length > 0
          ? gated.map((resource) => resource.id).join(', ')
          : 'AP2 is enabled but no resource requires it, so every purchase settles without a mandate',
    });

    checks.push({
      name: 'AP2 unsupported',
      status: 'INFO',
      detail: AP2_UNSUPPORTED.join(', '),
    });
  }

  // 6. Payments
  const x402 = config?.payments.x402;
  if (x402 === undefined || !x402.enabled) {
    checks.push({ name: 'Payments', status: 'INFO', detail: 'x402 not configured' });
  } else {
    const { mode, where, via } = describeSettlement(x402.network, x402.facilitator);
    const overrides = Object.keys(x402.resourcePaymentFlows ?? {}).length;
    const overrideCount =
      overrides > 0 ? ` (${overrides} resource ${overrides === 1 ? 'override' : 'overrides'})` : '';
    const flow = `paymentFlow=${x402.paymentFlow ?? 'authorization'}${overrideCount}`;
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

  // 7. Storage
  if (config === undefined) {
    checks.push({ name: 'Storage', status: 'WARN', detail: 'skipped: config invalid' });
  } else if (
    // Diagnose without creating: createSqliteReceiptStore creates the file,
    // so opening a wrong path (a typo, or a container path read from the
    // host) would leave an empty database and report it healthy, hiding the
    // real one. `:memory:` never exists on disk, so it takes the open branch
    // below.
    config.storage.receipts.path !== ':memory:' &&
    !existsSync(config.storage.receipts.path)
  ) {
    checks.push({
      name: 'Storage',
      status: 'WARN',
      detail:
        `${missingStoreDetail(config.storage.receipts.path)}. If the gateway is ` +
        'already running, this path does not match the one it uses.',
    });
  } else {
    let store: ReceiptStore | undefined;
    try {
      store = createStore(config.storage.receipts.path);
      await store.init();
      const storeHealth = await store.health();
      let receiptCount: number | undefined;
      try {
        // Exact count, not a list length: listReceipts clamps every page
        receiptCount = await store.countReceipts();
      } catch {
        receiptCount = undefined;
      }
      let undeliveredCount: number | undefined;
      try {
        // Paid but undelivered purchases (see
        // `ReceiptStore.countUndeliveredReceipts`), the rows the dashboard
        // flags as "Charged but not delivered"
        undeliveredCount = await store.countUndeliveredReceipts();
      } catch {
        undeliveredCount = undefined;
      }
      const status: CheckStatus =
        storeHealth.status === 'pass' ? 'PASS' : storeHealth.status === 'warn' ? 'WARN' : 'FAIL';
      const receiptsSuffix =
        receiptCount !== undefined
          ? `; receipts=${receiptCount}${undeliveredCount !== undefined && undeliveredCount > 0 ? ` (${undeliveredCount} undelivered)` : ''}`
          : '';
      checks.push({
        name: 'Storage',
        status,
        detail: `${storeHealth.detail ?? 'sqlite'}${receiptsSuffix}`,
      });
    } catch (err) {
      checks.push({
        name: 'Storage',
        status: 'FAIL',
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await store?.close();
    }
  }

  // 8. Protocol versions
  if (wellKnown?.ok) {
    checks.push({
      name: 'Protocol versions',
      status: 'PASS',
      detail: 'reported by gateway /.well-known/agent-commerce',
    });
  } else {
    const local = readVersionReport();
    checks.push({
      name: 'Protocol versions',
      status: 'INFO',
      detail: `gateway unreachable; local pins: ${local.pinned.map((p) => `${p.name}@${p.version}`).join(', ')}`,
    });
  }

  const scored = checks.filter((c) => c.status !== 'INFO');
  const passed = scored.filter((c) => c.status === 'PASS').length;
  const exitCode = checks.some((c) => c.status === 'FAIL') ? 1 : 0;

  return { checks, score: { passed, total: scored.length }, exitCode };
}

function statusColor(status: CheckStatus, text: string): string {
  switch (status) {
    case 'PASS':
      return picocolors.green(text);
    case 'WARN':
      return picocolors.yellow(text);
    case 'FAIL':
      return picocolors.red(text);
    case 'INFO':
      return picocolors.cyan(text);
  }
}

export function printDoctorReport(report: DoctorReport, io: Io, json: boolean): void {
  if (json) {
    io.stdout(JSON.stringify(report, null, 2));
    return;
  }
  for (const check of report.checks) {
    const label = statusColor(check.status, check.status.padEnd(5));
    io.stdout(`${label} ${check.name.padEnd(20)} ${check.detail}`);
  }
  io.stdout('');
  io.stdout(`Score: ${report.score.passed}/${report.score.total} checks passed`);
}
