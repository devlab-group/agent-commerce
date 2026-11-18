// The MCP Registry listing (`server.json`) for a gateway, built from config alone
import { joinUrl } from '../../protocols/http';
import type { GatewayConfig } from './config-client';

/** The `server.json` schema revision the listing follows */
export const SERVER_JSON_SCHEMA =
  'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';

export interface ServerJson {
  readonly $schema: typeof SERVER_JSON_SCHEMA;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly remotes: readonly [{ readonly type: 'streamable-http'; readonly url: string }];
}

/** Why a listing cannot be written, naming the config key to change */
export interface RegistryProblem {
  readonly key: string;
  readonly message: string;
}

/**
 * Builds a listing from validated `config`, or returns the problems found.
 * Requires MCP to be enabled and registry metadata to be present. The remote
 * URL joins `merchant.publicBaseUrl` and the MCP mount; it must use HTTPS and
 * must not name `localhost`, `127.0.0.1` or `*.localhost`. The version comes
 * from `protocols.mcp.registry`, independently of the package version.
 */
export function serverJson(
  config: GatewayConfig,
): { readonly document: ServerJson } | { readonly problems: readonly RegistryProblem[] } {
  const { mcp } = config.protocols;
  const problems: RegistryProblem[] = [];
  if (!mcp.enabled) {
    problems.push({
      key: 'protocols.mcp.enabled',
      message: 'is false: the listing would name a server that does not run',
    });
  }
  if (mcp.registry === undefined) {
    problems.push({
      key: 'protocols.mcp.registry',
      message: 'is not set: it holds the listing name, version and description',
    });
  }
  const url = remoteUrl(config.merchant.publicBaseUrl, mcp.mountPath);
  if (typeof url === 'string') problems.push({ key: 'merchant.publicBaseUrl', message: url });

  if (mcp.registry === undefined || typeof url === 'string' || problems.length > 0) {
    return { problems };
  }
  return {
    document: {
      $schema: SERVER_JSON_SCHEMA,
      name: mcp.registry.name,
      description: mcp.registry.description,
      version: mcp.registry.version,
      remotes: [{ type: 'streamable-http', url: url.href }],
    },
  };
}

// Check the remote URL against the registry's `IsValidRemoteURL` rules
function remoteUrl(publicBaseUrl: string, mountPath: string): URL | string {
  let url: URL;
  try {
    url = new URL(joinUrl(publicBaseUrl, mountPath));
  } catch {
    return 'is not a URL';
  }
  if (url.protocol !== 'https:') return 'must be an https:// URL: the MCP Registry refuses others';
  const host = url.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost')) {
    return `names ${host}, which the MCP Registry refuses`;
  }
  return url;
}
