// Protocol checks: what is enabled, and the A2A and ACP specifics

// Narrow modules, not the protocol barrels: the CLI must pull in no protocol SDK
import {
  A2A_AGENT_CARD_PATH,
  A2A_PROTOCOL_BINDING,
  A2A_PROTOCOL_VERSION,
  A2A_SPEC_VERSION,
} from '../../../protocols/a2a/constants';
import { A2A_UNSUPPORTED } from '../../../protocols/a2a/descriptor';
import {
  ACP_API_VERSION,
  ACP_SPEC_VERSION,
  ACP_WELL_KNOWN_PATH,
} from '../../../protocols/acp/constants';
import { ACP_UNSUPPORTED } from '../../../protocols/acp/descriptor';
import type { GatewayConfig } from '../../lib/config-client';
import { storeFileCheck } from './storage';
import type { DoctorCheck, WellKnownResult } from './types';

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

// Protocols, then the A2A and ACP specifics
export function protocolChecks(
  config: GatewayConfig | undefined,
  wellKnown: WellKnownResult | undefined,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
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
  return checks;
}
