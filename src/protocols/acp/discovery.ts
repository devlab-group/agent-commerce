/**
 * The `/.well-known/acp.json` seller discovery document.
 *
 * It advertises what this adapter implements: one transport, one service, one
 * API version. Optional metadata appears only when an operator configured it;
 * currencies are never inferred from the x402 configuration, a different
 * payment domain.
 *
 * The document is public, so the bearer token, backend URLs, resource mapping
 * and idempotency database location are not even inputs to this function.
 */
import { joinUrl } from '../http';
import { ACP_SPEC_VERSION } from './constants';

/** Discovery metadata an operator may configure. Absent fields are omitted, never guessed */
export interface AcpDiscoveryMetadata {
  readonly documentationUrl?: string;
  readonly supportedCurrencies?: readonly string[];
  readonly supportedLocales?: readonly string[];
  readonly interventionTypes?: readonly string[];
}

export interface AcpDiscoveryOptions {
  /** Externally reachable base URL of the gateway */
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
    // REST only: ACP's MCP transport is a fixed checkout binding, not the
    // generic MCP adapter this gateway also serves
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
