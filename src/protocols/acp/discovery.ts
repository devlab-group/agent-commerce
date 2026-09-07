/**
 * The `/.well-known/acp.json` seller discovery document.
 *
 * It advertises exactly what this adapter implements: one transport, one
 * service, one API version. Optional metadata appears only when an operator
 * configured it - in particular currencies are never inferred from the
 * gateway's x402 configuration, which is a different payment domain entirely.
 *
 * Nothing derived from a secret goes in here: the document is public and
 * unauthenticated, so bearer token, backend URLs, resource mapping ids and the
 * idempotency database location all stay out by construction - they are not
 * inputs to this function.
 */
import { ACP_SPEC_VERSION } from './constants.js';

/** Discovery metadata an operator may configure. Absent fields are omitted, never guessed. */
export interface AcpDiscoveryMetadata {
  readonly documentationUrl?: string;
  readonly supportedCurrencies?: readonly string[];
  readonly supportedLocales?: readonly string[];
  readonly interventionTypes?: readonly string[];
}

export interface AcpDiscoveryOptions {
  /** Externally reachable base URL of the gateway. */
  readonly publicBaseUrl: string;
  readonly mountPath: string;
  readonly metadata?: AcpDiscoveryMetadata;
}

export function buildAcpDiscoveryDocument(options: AcpDiscoveryOptions): Record<string, unknown> {
  const metadata = options.metadata ?? {};
  return {
    protocol: {
      name: 'acp',
      version: ACP_SPEC_VERSION,
      supported_versions: [ACP_SPEC_VERSION],
      ...(metadata.documentationUrl !== undefined
        ? { documentation_url: metadata.documentationUrl }
        : {}),
    },
    api_base_url: joinUrl(options.publicBaseUrl, options.mountPath),
    // Only the REST binding. ACP's MCP transport is its own fixed checkout
    // binding and is not the generic MCP adapter this gateway also serves;
    // advertising it here because "we do MCP" would be a false claim.
    transports: ['rest'],
    capabilities: {
      services: ['checkout'],
      ...(metadata.interventionTypes !== undefined
        ? { intervention_types: metadata.interventionTypes }
        : {}),
      ...(metadata.supportedCurrencies !== undefined
        ? { supported_currencies: metadata.supportedCurrencies }
        : {}),
      ...(metadata.supportedLocales !== undefined
        ? { supported_locales: metadata.supportedLocales }
        : {}),
    },
  };
}

function joinUrl(baseUrl: string, mountPath: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${mountPath.replace(/^\/+|\/+$/g, '')}`;
}
