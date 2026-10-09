// The business-rule pass: coerces leaves and checks cross-references across sections
import { CommerceError } from '../../core';
import { normalizeAcp, validateAcpCheckoutMapping } from './acp';
import { normalizeAp2, validateReplayStoreIsolated } from './ap2';
import { normalizeMpp } from './mpp';
import { type RawConfig, SUPPORTED_CONFIG_VERSION } from './raw';
import { normalizeResource } from './resources';
import type { GatewayConfig, NormalizedProtocols } from './types';
import { toBoolean, toNumber } from './values';
import { normalizeX402 } from './x402';

// Applied when `protocols.a2a` is absent or names no mount
const DEFAULT_A2A_MOUNT_PATH = '/a2a';

export function normalize(raw: RawConfig): GatewayConfig {
  const protocols = {
    http: { enabled: toBoolean(raw.protocols.http.enabled, 'protocols.http.enabled') },
    mcp: {
      enabled: toBoolean(raw.protocols.mcp.enabled, 'protocols.mcp.enabled'),
      mountPath: raw.protocols.mcp.mountPath,
    },
    a2a: {
      enabled: toBoolean(raw.protocols.a2a?.enabled ?? false, 'protocols.a2a.enabled'),
      mountPath: raw.protocols.a2a?.mountPath ?? DEFAULT_A2A_MOUNT_PATH,
    },
    acp: normalizeAcp(raw.protocols.acp),
  };
  validateMountPaths(protocols);

  const x402Settings =
    raw.payments.x402 !== undefined ? normalizeX402(raw.payments.x402) : undefined;
  const x402 = x402Settings?.config;

  const mpp = normalizeMpp(raw.payments.mpp);

  const ap2 = normalizeAp2(raw.authorization?.ap2);
  if (ap2?.enabled) {
    validateReplayStoreIsolated(ap2.replay.path, raw.storage.receipts.path, protocols.acp);
  }

  const resources = Object.entries(raw.resources).map(([id, entry]) =>
    normalizeResource(id, entry, protocols, x402Settings, mpp, ap2),
  );
  // CommerceResource has no payment-flow field. Each listed rail carries the
  // overrides; the selected rail applies them.
  const flowOverrides = (rail: 'x402' | 'mpp') => {
    const flows = Object.fromEntries(
      resources.flatMap((resource) => {
        const flow = raw.resources[resource.id]?.paymentFlow;
        return flow !== undefined && resource.paymentMethods.includes(rail)
          ? [[resource.id, flow]]
          : [];
      }),
    );
    return Object.keys(flows).length > 0 ? { resourcePaymentFlows: flows } : {};
  };
  const x402WithFlows = x402 !== undefined ? { ...x402, ...flowOverrides('x402') } : x402;
  const mppWithFlows = mpp !== undefined ? { ...mpp, ...flowOverrides('mpp') } : mpp;
  if (protocols.acp.enabled) validateAcpCheckoutMapping(protocols.acp, resources);
  // Require an exposed resource so the enabled adapter publishes a skill
  if (protocols.a2a.enabled && !resources.some((r) => r.exposedVia.includes('a2a'))) {
    throw new CommerceError(
      'CONFIG_INVALID',
      'protocols.a2a.enabled is true but no resource lists "a2a" in its expose',
      { details: { path: 'protocols.a2a.enabled' } },
    );
  }

  return {
    version: SUPPORTED_CONFIG_VERSION,
    merchant: {
      id: raw.merchant.id,
      name: raw.merchant.name,
      publicBaseUrl: raw.merchant.publicBaseUrl,
    },
    // Port 0 lets the OS pick a free port, for tests and throwaway instances
    server: {
      port: toNumber(raw.server.port, 'server.port', { min: 0, max: 65535 }),
      host: raw.server.host,
      ...(raw.server.adminToken !== undefined ? { adminToken: raw.server.adminToken } : {}),
      allowedOrigins: raw.server.allowedOrigins ?? [],
    },
    storage: { receipts: { driver: 'sqlite', path: raw.storage.receipts.path } },
    protocols,
    resources,
    payments: {
      ...(x402WithFlows !== undefined ? { x402: x402WithFlows } : {}),
      ...(mppWithFlows !== undefined ? { mpp: mppWithFlows } : {}),
    },
    ...(ap2 !== undefined ? { authorization: { ap2 } } : {}),
  };
}

// Two enabled mounts may not overlap: each registers a `${mountPath}/*`
// wildcard, so a shared prefix lets one adapter answer for the other. Disabled
// protocols mount nothing and are not compared.
function validateMountPaths(protocols: NormalizedProtocols): void {
  const mounts = (
    [
      ['mcp', protocols.mcp],
      ['a2a', protocols.a2a],
      ['acp', protocols.acp],
    ] as const
  ).filter(([, p]) => p.enabled);

  for (const [index, [nameA, a]] of mounts.entries()) {
    for (const [nameB, b] of mounts.slice(index + 1)) {
      const baseA = a.mountPath.replace(/\/+$/, '');
      const baseB = b.mountPath.replace(/\/+$/, '');
      if (baseA === baseB || baseA.startsWith(`${baseB}/`) || baseB.startsWith(`${baseA}/`)) {
        throw new CommerceError(
          'CONFIG_INVALID',
          `protocols.${nameA}.mountPath ("${a.mountPath}") collides with protocols.${nameB}.mountPath ("${b.mountPath}") - each mount registers a wildcard, so overlapping prefixes cannot both be served`,
          { details: { path: `protocols.${nameA}.mountPath` } },
        );
      }
    }
  }
}
