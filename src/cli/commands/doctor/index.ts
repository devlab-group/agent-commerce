// `agent-commerce doctor`: config, the running gateway, protocols, payments and storage
import { type CommerceResource, isCommerceError } from '../../../core';
import { extractPathParameterNames } from '../../../core/execution';
import { createSqliteReceiptStore } from '../../../storage/receipts';
import { type GatewayConfig, loadConfigDynamic } from '../../lib/config-client';
import { fetchJson } from '../../lib/http';
import {
  fillEnvFromLocalChainManifest,
  hasChainDeployScript,
  LOCAL_CHAIN_MANIFEST_PATH,
  unresolvedVariableHint,
} from '../../lib/manifest-env';
import { readVersionReport } from '../../lib/versions';
import { ap2Checks } from './ap2';
import { paymentChecks } from './payments';
import { protocolChecks } from './protocols';
import { storageChecks } from './storage';
import type { CheckStatus, DoctorCheck, DoctorDeps, DoctorOptions, DoctorReport } from './types';

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

/** `agent-commerce doctor [--config] [--gateway] [--json]` */
export async function runDoctor(
  options: DoctorOptions,
  deps: DoctorDeps = {},
): Promise<DoctorReport> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const loadConfig = deps.loadConfig ?? loadConfigDynamic;
  const createStore = deps.createStore ?? ((path: string) => createSqliteReceiptStore({ path }));
  const fillEnvFromManifest = deps.fillEnvFromManifest ?? fillEnvFromLocalChainManifest;
  const chainDeploy = (deps.hasChainDeployScript ?? hasChainDeployScript)();

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
      typeof variable === 'string'
        ? `. Hint: ${unresolvedVariableHint(variable, manifestFound, chainDeploy)}`
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

  // 5-7. Protocols, AP2, payments and storage
  checks.push(...protocolChecks(config, wellKnown));
  checks.push(...ap2Checks(config));
  checks.push(...paymentChecks(config, wellKnown, gatewayUrl, chainDeploy));
  checks.push(...(await storageChecks(config, createStore)));

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

export { printDoctorReport } from './report';
export type { CheckStatus, DoctorCheck, DoctorDeps, DoctorOptions, DoctorReport } from './types';
