import { existsSync } from 'node:fs';
import picocolors from 'picocolors';
import { extractPathParameterNames } from '../../core/execution/index.js';
import { type CommerceResource, isCommerceError, type ReceiptStore } from '../../core/index.js';
import {
  describeDeploymentMode,
  findNetworkProfile,
  resolveDeploymentMode,
} from '../../payments/x402/networks.js';
import { createSqliteReceiptStore } from '../../storage/receipts/index.js';
import { type ConfigLoader, type GatewayConfig, loadConfigDynamic } from '../lib/config-client.js';
import { type FetchLike, fetchJson } from '../lib/http.js';
import { PLACEHOLDER_ASSET_ADDRESS } from '../lib/init-config.js';
import type { Io } from '../lib/io.js';
import {
  fillEnvFromLocalChainManifest,
  LOCAL_CHAIN_MANIFEST_PATH,
  MANIFEST_FILLABLE_ENV_VAR_NAMES,
  type ManifestEnvFill,
} from '../lib/manifest-env.js';
import { maskMiddle } from '../lib/mask.js';
import { readVersionReport } from '../lib/versions.js';

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
    // `0.0.0.0` means "all interfaces"; probe the loopback one. `::` is its
    // IPv6 equivalent. A literal IPv6 host such as `::1`
    // must be bracketed or the derived URL is invalid (`http://::1:8080`) and
    // doctor reported every running gateway as unreachable.
    const raw = config.server.host;
    const host = raw === '0.0.0.0' ? '127.0.0.1' : raw === '::' ? '::1' : raw;
    const authority = host.includes(':') ? `[${host}]` : host;
    return `http://${authority}:${config.server.port}`;
  }
  return 'http://localhost:8080';
}

/**
 * Fill `{param}` slots with a probe value, using the *canonical* grammar.
 *
 * A local `/\{[^}]+\}/g` here would recognise more than the runtime does. A
 * kebab-case token like `{report-id}` would match here and not there, so
 * `doctor` would probe `/report/demo-check` — the URL the operator meant —
 * and report the backend reachable, while every real request went to
 * `/report/%7Breport-id%7D` and 404'd after settling payment. A diagnostic
 * that probes a URL the runtime would never build is
 * worse than no diagnostic: it certifies the broken thing as healthy. Anything
 * the shared extractor does not recognise is deliberately left as-is, so the
 * probe hits exactly what the gateway would send.
 */
function substitutePathParams(url: string): string {
  let filled = url;
  for (const name of extractPathParameterNames(url)) {
    filled = filled.split(`{${name}}`).join('demo-check');
  }
  return filled;
}

interface LiveX402 {
  readonly asset: string;
  readonly network: string;
  readonly payTo: string;
}

/**
 * Pulls the gateway's *effective* x402 settlement config out of
 * `/.well-known/agent-commerce` (src/gateway/well-known.ts). Returns
 * undefined for anything short of "the gateway confirms x402 is enabled and
 * reports all three fields" — a doctor cross-check must never itself become
 * an unchecked cast on network-supplied JSON.
 */
/**
 * `undefined` must not be allowed to mean three different things — gateway
 * down, document malformed, and *the gateway positively reporting x402
 * disabled*. The third is not an absence of information, it is a
 * disagreement: local config enables x402, the running gateway says it does
 * not, which is exactly the deployment-mismatch this cross-check was built to
 * catch. Reporting it as "could not be verified" turned the finding into a
 * shrug. `'disabled'` separates it out.
 */
type LiveX402Result = LiveX402 | 'disabled' | undefined;

function extractWellKnownX402(body: Record<string, unknown> | undefined): LiveX402Result {
  const payments = body?.['payments'];
  if (typeof payments !== 'object' || payments === null) return undefined;
  const x402 = (payments as Record<string, unknown>)['x402'];
  if (typeof x402 !== 'object' || x402 === null) return undefined;
  const rec = x402 as Record<string, unknown>;
  // Only an explicit `false` is a positive statement. Anything else (absent,
  // null, a non-boolean) is still "cannot tell".
  if (rec['enabled'] === false) return 'disabled';
  if (rec['enabled'] !== true) return undefined;
  const { asset, network, payTo } = rec;
  if (typeof asset !== 'string' || typeof network !== 'string' || typeof payTo !== 'string') {
    return undefined;
  }
  return { asset, network, payTo };
}

/** Addresses are checksum-insensitive throughout this project (src/config/schema.ts). */
function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * A doctor that reports healthy against a mismatched deployment is worse
 * than no diagnostic at all false-green finding). Compares
 * the gateway's live settlement config against what the local config
 * resolved to, and names both values so the operator knows exactly what to
 * check rather than just that something disagrees.
 */
function findX402Mismatch(configured: LiveX402, live: LiveX402): string | undefined {
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
      `payTo: gateway is using ${live.payTo} but local config resolves to ${configured.payTo}`,
    );
  }
  if (diffs.length === 0) return undefined;
  return `${diffs.join('; ')} — the gateway may be running against an older deployment; restart it or re-run chain:deploy`;
}

/** `agent-commerce doctor [--config] [--gateway] [--json]`. */
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
      detail: `valid — ${config.resources.length} resource(s), merchant "${config.merchant.name}"${filledSuffix}`,
    });
  } catch (err) {
    const variable = isCommerceError(err) ? err.details?.['variable'] : undefined;
    const hint =
      !manifestFound &&
      typeof variable === 'string' &&
      MANIFEST_FILLABLE_ENV_VAR_NAMES.has(variable)
        ? ` — run "npm run chain:deploy" (writes ${LOCAL_CHAIN_MANIFEST_PATH}, read automatically for local X402_*/MERCHANT_WALLET placeholders)`
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
    checks.push({ name: 'Backend', status: 'WARN', detail: 'skipped — config invalid' });
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
    checks.push({ name: 'Protocols', status: 'WARN', detail: 'skipped — config invalid' });
  } else if (wellKnown === undefined || !wellKnown.ok) {
    checks.push({ name: 'Protocols', status: 'FAIL', detail: 'well-known document unreachable' });
  } else {
    const mcpMountPath = config.protocols.mcp.enabled ? config.protocols.mcp.mountPath : undefined;
    checks.push({
      name: 'Protocols',
      status: 'PASS',
      detail: `http=${config.protocols.http.enabled ? 'on' : 'off'} mcp=${config.protocols.mcp.enabled ? `on (${mcpMountPath})` : 'off'}`,
    });
  }

  // 6. Payments
  const x402 = config?.payments.x402;
  if (x402 === undefined || !x402.enabled) {
    checks.push({ name: 'Payments', status: 'INFO', detail: 'x402 not configured' });
  } else {
    // The protocol version is named because chain id 84532 is shared with the
    // public Base Sepolia testnet: the *mode* is what says whether this
    // deployment settles on a local dev node or a public network, and nothing
    // here may be read as a claim about a public network on its own.
    //
    // A config whose network is unknown cannot reach here in normal operation
    // — `parseConfig` refuses it — so an absent profile means doctor is
    // reading a config some other loader produced. Say so rather than guess.
    const profile = findNetworkProfile(x402.network);
    const mode = profile ? resolveDeploymentMode(profile, x402.facilitator.mode) : undefined;
    // Naming the public network while in local mode would read as a claim to
    // be on it — the exact confusion the shared chain id creates. Local says
    // "dev chain"; only a remote facilitator earns the network's name.
    const where =
      profile === undefined || mode === undefined
        ? `unknown network ${x402.network}`
        : mode === 'local'
          ? `LOCAL dev chain (${x402.network}, chain id shared with ${profile.displayName})`
          : `${describeDeploymentMode(mode)} on ${profile.displayName} (${x402.network})`;
    const facilitatorDetail =
      x402.facilitator.mode === 'local' ? 'local' : `remote (auth=${x402.facilitator.auth.type})`;
    const summary = `x402 v2 (scheme=exact) enabled — ${where}, destination=${maskMiddle(x402.payTo)}, facilitator=${facilitatorDetail}`;
    const live = wellKnown?.ok ? extractWellKnownX402(wellKnown.body) : undefined;
    if (sameAddress(x402.asset, PLACEHOLDER_ASSET_ADDRESS)) {
      // `init --yes` writes this placeholder, and the
      // live cross-check compares config against the gateway's echo of the
      // same config — so everything matched and the report said 7/7 PASS on a
      // deployment where no paid call can ever succeed, because no token
      // contract exists at that address. Fail-closed holds and no funds are at
      // risk; the overstatement is the defect.
      checks.push({
        name: 'Payments',
        status: 'WARN',
        detail: `${summary}, but the asset is still the init placeholder ${maskMiddle(PLACEHOLDER_ASSET_ADDRESS)} — no token contract exists there, so every paid call will fail. Set payments.x402.asset (\${X402_ASSET} is filled from .deploy/local.json by "npm run chain:deploy")`,
      });
    } else if (live === 'disabled') {
      // Verified, and it disagrees. Every paid call against this gateway will
      // be served free or refused, depending on the resource — either way the
      // deployment is not what this config describes.
      checks.push({
        name: 'Payments',
        status: 'FAIL',
        detail: `${summary}, but the gateway at ${gatewayUrl} reports x402 disabled — it is running a different configuration`,
      });
    } else if (live === undefined) {
      // Gateway unreachable, x402 not (yet) reported live, or the document
      // didn't parse as expected — can't judge a match either way, so this
      // is not a FAIL: a doctor that fails on things it cannot check is as
      // untrustworthy as one that passes on things it never checked.
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
      // Reporting, not re-checking. Every one of these is refused at config
      // load (src/payments/x402/guardrails.ts), so a config that got this far
      // has already passed them — but an operator about to move real money
      // should be told which guarantees they are relying on, and see the
      // banner without having to read a log.
      checks.push({
        name: 'Mainnet safety',
        status: 'INFO',
        detail:
          `${describeDeploymentMode('mainnet')} — enforced at config load: explicit allowMainnet ` +
          'opt-in, remote facilitator over HTTPS with a credential, non-development payTo, ' +
          'and the canonical asset for this network. Payments are fail-closed.',
      });
    }
  }
  checks.push({
    name: 'Payments (MPP)',
    status: 'INFO',
    detail: 'planned — not implemented in v0.1',
  });

  // 7. Storage
  if (config === undefined) {
    checks.push({ name: 'Storage', status: 'WARN', detail: 'skipped — config invalid' });
  } else if (
    // Diagnose without creating: createSqliteReceiptStore mkdir+creates the
    // file, so calling it on a wrong path (a typo, or a container path read
    // from the host) silently produces a fresh empty database and a false
    // "healthy, receipts=0" PASS — a read-only command must not have this
    // side effect, and it shadows the real store's real receipts entirely.
    // `:memory:` never exists on disk by definition, so it always falls
    // through to the real open/health/count branch below, same as today.
    config.storage.receipts.path !== ':memory:' &&
    !existsSync(config.storage.receipts.path)
  ) {
    checks.push({
      name: 'Storage',
      status: 'WARN',
      detail:
        `no store exists yet at "${config.storage.receipts.path}" — it is created ` +
        'automatically the first time the gateway starts. If the gateway is already ' +
        'running, this path does not match the one it actually uses.',
    });
  } else {
    let store: ReceiptStore | undefined;
    try {
      store = createStore(config.storage.receipts.path);
      await store.init();
      const storeHealth = await store.health();
      let receiptCount: number | undefined;
      try {
        // Exact count, not a list length: listReceipts clamps to
        // MAX_LIST_LIMIT (500, a store-level invariant) so counting via the
        // list silently saturated at 500 forever.
        receiptCount = await store.countReceipts();
      } catch {
        receiptCount = undefined;
      }
      let undeliveredCount: number | undefined;
      try {
        // A paid-but-undelivered purchase looks identical to a successful
        // one everywhere else; this is what makes it visible to an operator
        // running doctor. Same signal the
        // dashboard's receipt table uses, so the two views cannot disagree.
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
  if (wellKnown !== undefined && wellKnown.ok) {
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
      detail: `gateway unreachable — local pins: ${local.pinned.map((p) => `${p.name}@${p.version}`).join(', ')}`,
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
