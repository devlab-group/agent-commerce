// The business-rule pass: coerces leaves and checks cross-references across sections
import type { CommerceResource } from '../../core';
import { CommerceError } from '../../core';
import { bazaarMetadata } from '../../payments/x402/provider/bazaar';
import { A2A_MAX_RETAINED_TASKS, A2A_TASK_RETENTION_HOURS } from '../../protocols/a2a/constants';
import { publicEndpointUrl } from '../../protocols/http';
import { normalizeAcp, validateAcpCheckoutMapping } from './acp';
import { normalizeAp2, validateLegacyStoresIsolated } from './ap2';
import { normalizeMpp } from './mpp';
import { isHttpUrl, type RawConfig, SUPPORTED_CONFIG_VERSION } from './raw';
import { normalizeResource, servingRailOf } from './resources';
import type { A2aProtocolConfig, GatewayConfig, NormalizedProtocols } from './types';
import { toBoolean, toNumber } from './values';
import { normalizeX402 } from './x402';

// Applied when `protocols.a2a` is absent or names no mount
const DEFAULT_A2A_MOUNT_PATH = '/a2a';

// Preserve configured limits and leave unset keys absent
function normalizeA2aTasks(
  tasks: NonNullable<RawConfig['protocols']['a2a']>['tasks'],
): Pick<A2aProtocolConfig, 'tasks'> {
  if (tasks === undefined) return {};
  return {
    tasks: {
      ...(tasks.retentionHours !== undefined
        ? {
            retentionHours: toNumber(
              tasks.retentionHours,
              'protocols.a2a.tasks.retentionHours',
              A2A_TASK_RETENTION_HOURS,
            ),
          }
        : {}),
      ...(tasks.maxRetained !== undefined
        ? {
            maxRetained: toNumber(
              tasks.maxRetained,
              'protocols.a2a.tasks.maxRetained',
              A2A_MAX_RETAINED_TASKS,
            ),
          }
        : {}),
    },
  };
}

export function normalize(raw: RawConfig): GatewayConfig {
  const protocols = {
    http: { enabled: toBoolean(raw.protocols.http.enabled, 'protocols.http.enabled') },
    mcp: {
      enabled: toBoolean(raw.protocols.mcp.enabled, 'protocols.mcp.enabled'),
      mountPath: raw.protocols.mcp.mountPath,
      ...(raw.protocols.mcp.registry !== undefined ? { registry: raw.protocols.mcp.registry } : {}),
    },
    a2a: {
      enabled: toBoolean(raw.protocols.a2a?.enabled ?? false, 'protocols.a2a.enabled'),
      mountPath: raw.protocols.a2a?.mountPath ?? DEFAULT_A2A_MOUNT_PATH,
      ...normalizeA2aTasks(raw.protocols.a2a?.tasks),
    },
    acp: normalizeAcp(raw.protocols.acp),
  };
  validateMountPaths(protocols);

  const x402Settings =
    raw.payments.x402 !== undefined ? normalizeX402(raw.payments.x402, raw.resources) : undefined;
  const x402 = x402Settings?.config;

  const mpp = normalizeMpp(raw.payments.mpp);

  const ap2 = normalizeAp2(raw.authorization?.ap2);
  validateLegacyStoresIsolated(ap2, protocols.acp, raw.storage.receipts.path);

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
  // The same holds for media types, which only x402 challenges carry
  const mimeTypes = Object.fromEntries(
    resources.flatMap((resource) => {
      const mimeType = raw.resources[resource.id]?.mimeType;
      return mimeType !== undefined ? [[resource.id, mimeType]] : [];
    }),
  );
  // Build URL mappings and metadata for resources whose serving rail is x402
  const rails = { x402: x402?.enabled === true, mpp: mpp?.enabled === true };
  const railOf = (resource: CommerceResource) => servingRailOf(resource.paymentMethods, rails);
  const onX402 = resources.filter((resource) => railOf(resource) === 'x402');
  const publicUrl = raw.payments.x402?.publicResourceUrl;
  const resourceUrls =
    publicUrl !== undefined && toBoolean(publicUrl, 'payments.x402.publicResourceUrl')
      ? publicResourceUrls(raw.merchant.publicBaseUrl, protocols, onX402)
      : undefined;
  const bazaarRaw = raw.payments.x402?.bazaar;
  const resourceBazaar =
    bazaarRaw !== undefined && toBoolean(bazaarRaw.enabled, 'payments.x402.bazaar.enabled')
      ? bazaarExtensions(resourceUrls, resources, mimeTypes, railOf)
      : undefined;
  const x402WithFlows =
    x402 !== undefined
      ? {
          ...x402,
          ...flowOverrides('x402'),
          ...(Object.keys(mimeTypes).length > 0 ? { resourceMimeTypes: mimeTypes } : {}),
          ...(resourceUrls !== undefined ? { resourceUrls } : {}),
          ...(resourceBazaar !== undefined ? { resourceBazaar } : {}),
        }
      : x402;
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

  // Preserve 2.x compatibility: warn about invalid URLs instead of rejecting them
  if (!isHttpUrl(raw.merchant.publicBaseUrl)) {
    console.warn(
      `[agent-commerce] merchant.publicBaseUrl ${JSON.stringify(raw.merchant.publicBaseUrl)} is not an http:// or https:// URL. The Host check may then refuse every caller but loopback, and the A2A Agent Card and ACP discovery publish broken URLs.`,
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

// Build Bazaar metadata for public URLs and report omitted resources or surfaces
// during config loading. Omitting metadata leaves payment behavior unchanged.
function bazaarExtensions(
  resourceUrls: Record<string, Partial<Record<'http' | 'mcp' | 'a2a', string>>> | undefined,
  resources: readonly CommerceResource[],
  mimeTypes: Readonly<Record<string, string>>,
  railOf: (resource: CommerceResource) => string | undefined,
): NonNullable<GatewayConfig['payments']['x402']>['resourceBazaar'] {
  if (resourceUrls === undefined) {
    throw new CommerceError(
      'CONFIG_INVALID',
      'payments.x402.bazaar.enabled requires payments.x402.publicResourceUrl: true',
      { details: { path: 'payments.x402.bazaar.enabled' } },
    );
  }
  return Object.fromEntries(
    resources.flatMap((resource) => {
      const urls = resourceUrls[resource.id];
      if (urls === undefined) {
        const rail = railOf(resource);
        if (resource.paymentMethods.includes('x402') && rail !== undefined) {
          console.warn(
            `[agent-commerce] resource "${resource.id}" gets no Bazaar metadata: the gateway serves it on ${rail}, the first enabled rail in its payments, which issues no x402 challenge. Payment is unaffected.`,
          );
        }
        return [];
      }
      const surfaces = (['http', 'mcp'] as const).filter((surface) => urls[surface] !== undefined);
      const { extensions, omitted } = bazaarMetadata(resource, surfaces, mimeTypes[resource.id]);
      for (const { surfaces: left, reason } of omitted) {
        console.warn(
          `[agent-commerce] resource "${resource.id}" gets no Bazaar metadata on ${left.join(' and ')}: ${reason}. Payment is unaffected.`,
        );
      }
      return Object.keys(extensions).length > 0 ? [[resource.id, extensions]] : [];
    }),
  );
}

// Build public endpoint URLs for the surfaces exposing resources served on
// x402, which indexers can request, unlike `resource://` identifiers
function publicResourceUrls(
  publicBaseUrl: string,
  protocols: NormalizedProtocols,
  resources: readonly CommerceResource[],
): Record<string, Partial<Record<'http' | 'mcp' | 'a2a', string>>> {
  if (!isHttpUrl(publicBaseUrl)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `payments.x402.publicResourceUrl needs merchant.publicBaseUrl to be an http:// or https:// URL, not ${JSON.stringify(publicBaseUrl)}`,
      { details: { path: 'merchant.publicBaseUrl' } },
    );
  }
  const path = (surface: 'http' | 'mcp' | 'a2a', id: string) =>
    surface === 'http'
      ? `/api/resources/${encodeURIComponent(id)}/invoke`
      : protocols[surface].mountPath;
  return Object.fromEntries(
    resources.map((resource) => [
      resource.id,
      Object.fromEntries(
        (['http', 'mcp', 'a2a'] as const)
          .filter((surface) => resource.exposedVia.includes(surface))
          .map((surface) => [
            surface,
            publicEndpointUrl(publicBaseUrl, path(surface, resource.id)),
          ]),
      ),
    ]),
  );
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
