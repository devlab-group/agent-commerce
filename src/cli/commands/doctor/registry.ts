// MCP Registry: the live listing of `protocols.mcp.registry.name`, checked with --registry
import { isRecord } from '../../../core/is-record';
import type { GatewayConfig } from '../../lib/config-client';
import { type FetchLike, fetchJson } from '../../lib/http';
import { type ServerJson, serverJson } from '../../lib/mcp-registry';
import { type DoctorCheck, SKIPPED_CONFIG_INVALID } from './types';

/** The registry `doctor --registry` reads */
export const MCP_REGISTRY_URL = 'https://registry.modelcontextprotocol.io';

const NAME = 'MCP Registry';
// Allow more time for the public registry than for gateway checks
const REGISTRY_TIMEOUT_MS = 5000;
const OFFICIAL_META = 'io.modelcontextprotocol.registry/official';

/**
 * Compares the configured name's latest listing with `export mcp-registry`
 * output. The request sends only the name. Listing and request problems produce
 * WARN because they do not establish deployment health. Treat the answer as
 * untrusted: report differing field names and known lifecycle statuses without
 * echoing arbitrary registry values or request error messages.
 */
export async function registryCheck(
  config: GatewayConfig | undefined,
  fetchImpl: FetchLike,
): Promise<DoctorCheck> {
  if (config === undefined) return { name: NAME, status: 'WARN', ...SKIPPED_CONFIG_INVALID };
  if (config.protocols.mcp.registry === undefined) {
    return { name: NAME, status: 'INFO', detail: 'protocols.mcp.registry not configured' };
  }
  const built = serverJson(config);
  if ('problems' in built) {
    return {
      name: NAME,
      status: 'WARN',
      detail: built.problems.map((problem) => `${problem.key} ${problem.message}`).join('; '),
    };
  }
  const local = built.document;
  const answer = await fetchJson(
    fetchImpl,
    `${MCP_REGISTRY_URL}/v0.1/servers/${encodeURIComponent(local.name)}/versions/latest`,
    REGISTRY_TIMEOUT_MS,
  );
  // An error message can carry text from the far end, such as certificate names
  if (answer.status === 0) {
    return answer.noAnswer === true
      ? {
          name: NAME,
          status: 'WARN',
          detail: 'no answer from the registry',
          undetermined: 'unreachable',
        }
      : { name: NAME, status: 'WARN', detail: 'the registry request failed' };
  }
  if (answer.status === 404) {
    return { name: NAME, status: 'WARN', detail: `${local.name} is not listed` };
  }
  if (!answer.ok || !isRecord(answer.body) || !isRecord(answer.body['server'])) {
    return {
      name: NAME,
      status: 'WARN',
      detail: answer.ok
        ? 'the registry answer is not a server listing'
        : `the registry answered HTTP ${answer.status}`,
    };
  }

  const problems = [
    ...lifecycle(answer.body['_meta']),
    ...differences(answer.body['server'], local),
  ];
  return problems.length === 0
    ? {
        name: NAME,
        status: 'PASS',
        detail: `${local.name} ${local.version} is listed as configured`,
      }
    : { name: NAME, status: 'WARN', detail: `${local.name}: ${problems.join('; ')}` };
}

// Only the registry's known status words reach the output
function lifecycle(meta: unknown): string[] {
  const official = isRecord(meta) ? meta[OFFICIAL_META] : undefined;
  const status = isRecord(official) ? official['status'] : undefined;
  if (status === 'active') return [];
  if (status === 'deprecated' || status === 'deleted') return [`listing is ${status}`];
  return ['listing has no known status'];
}

function differences(listed: Record<string, unknown>, local: ServerJson): string[] {
  const fields = (['name', 'version', 'description'] as const).filter(
    (field) => listed[field] !== local[field],
  );
  const remotes = listed['remotes'];
  const remote = Array.isArray(remotes) && remotes.length === 1 ? remotes[0] : undefined;
  const sameRemote =
    isRecord(remote) &&
    remote['type'] === local.remotes[0].type &&
    remote['url'] === local.remotes[0].url;
  const differing = sameRemote ? fields : [...fields, 'remotes'];
  return differing.length > 0 ? [`listing differs from config in ${differing.join(', ')}`] : [];
}
