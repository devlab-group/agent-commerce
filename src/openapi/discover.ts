/**
 * Turns OpenAPI path operations into a deterministic list of candidates.
 *
 * Determinism is the point: a resource id is what an agent discovers and
 * hard-codes, so it must depend only on the document, never on iteration order
 * or on how many times the importer has run. Anything ambiguous fails the
 * import instead of being silently renamed.
 */
import type { BackendMethod } from '../core/domain/resource.js';
import { CommerceError } from '../core/errors/index.js';
import { findUnparsedBraceToken } from '../core/execution/index.js';
import { dereference } from './refs.js';
import type {
  ImportDiagnostic,
  LoadedOpenApiDocument,
  OpenApiOperationCandidate,
} from './types.js';

const SUPPORTED_METHODS: Readonly<Record<string, BackendMethod>> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
};

/** Path Item members that are not operations. Anything else that is not a
 * supported method gets an explicit diagnostic rather than silent skipping. */
const NON_OPERATION_KEYS = new Set(['summary', 'description', 'servers', 'parameters', '$ref']);

/** The id character set Agent Commerce and MCP tool names already share. */
const ID_ALLOWED = /[^A-Za-z0-9_.-]+/g;
const MAX_ID_LENGTH = 128;

export interface DiscoverOptions {
  /** CLI `--base-url`. Wins over every server declared in the document. */
  readonly baseUrl?: string;
}

export interface DiscoveryResult {
  readonly operations: readonly OpenApiOperationCandidate[];
  readonly diagnostics: readonly ImportDiagnostic[];
}

export function discoverOperations(
  loaded: LoadedOpenApiDocument,
  options: DiscoverOptions = {},
): DiscoveryResult {
  const { document } = loaded;
  const diagnostics: ImportDiagnostic[] = [];
  const operations: OpenApiOperationCandidate[] = [];
  /** resource id -> the `METHOD path` that claimed it, for the collision message. */
  const claimed = new Map<string, string>();

  if (options.baseUrl !== undefined) assertAbsoluteHttpUrl(options.baseUrl, '--base-url');

  const paths = document['paths'];
  if (!isRecord(paths)) {
    return { operations, diagnostics };
  }

  const rootServers = document['servers'];
  const rootSecurity = document['security'];

  for (const [path, rawPathItem] of Object.entries(paths)) {
    if (path.startsWith('x-')) continue;
    if (!path.startsWith('/')) {
      diagnostics.push({
        severity: 'warning',
        code: 'invalid-path-key',
        operation: path,
        message: `Skipped "${path}": a Paths key must start with "/"`,
      });
      continue;
    }
    const pathItem = dereference(document, rawPathItem).value;
    if (!isRecord(pathItem)) continue;

    for (const [key, rawOperation] of Object.entries(pathItem)) {
      if (NON_OPERATION_KEYS.has(key) || key.startsWith('x-')) continue;
      const method = SUPPORTED_METHODS[key.toLowerCase()];
      if (method === undefined) {
        diagnostics.push({
          severity: 'warning',
          code: 'unsupported-method',
          operation: `${key.toUpperCase()} ${path}`,
          message: `Skipped ${key.toUpperCase()} ${path}: only GET, POST, PUT, PATCH and DELETE are supported`,
        });
        continue;
      }
      const operation = dereference(document, rawOperation).value;
      if (!isRecord(operation)) continue;

      const where = `${method} ${path}`;
      const operationId =
        typeof operation['operationId'] === 'string' ? operation['operationId'] : undefined;
      const resourceId = toResourceId(operationId, method, path);
      const previous = claimed.get(resourceId);
      if (previous !== undefined) {
        throw new CommerceError(
          'CONFIG_INVALID',
          `Operations "${previous}" and "${where}" both produce the resource id "${resourceId}". Give one of them a distinct operationId — ids are what agents discover, so the importer will not rename either`,
          { details: { resourceId, operations: [previous, where] } },
        );
      }
      claimed.set(resourceId, where);

      const server = selectServer(
        document,
        [operation['servers'], pathItem['servers'], rootServers],
        { where, resourceId },
        options,
        diagnostics,
      );
      if (server === undefined) continue;

      const backendUrl = `${server.replace(/\/+$/, '')}${path}`;
      const stray = findUnparsedBraceToken(backendUrl);
      if (stray !== undefined) {
        diagnostics.push({
          severity: 'error',
          code: 'unsupported-path-template',
          operation: resourceId,
          message: `Skipped ${where}: path template "${stray}" uses characters the gateway cannot substitute (allowed: A-Z a-z 0-9 _ . -)`,
        });
        continue;
      }

      const summary = typeof operation['summary'] === 'string' ? operation['summary'] : undefined;
      const description =
        typeof operation['description'] === 'string' ? operation['description'] : summary;
      const security = operation['security'] ?? rootSecurity;

      operations.push({
        resourceId,
        method,
        path,
        backendUrl,
        ...(operationId !== undefined ? { operationId } : {}),
        name: summary ?? operationId ?? resourceId,
        ...(description !== undefined ? { description } : {}),
        parameters: [
          ...toArray(pathItem['parameters']),
          // Operation parameters last: Phase 4 lets the later one win, which is
          // the OpenAPI override rule (same name + in).
          ...toArray(operation['parameters']),
        ],
        ...(operation['requestBody'] !== undefined
          ? { requestBody: operation['requestBody'] }
          : {}),
        ...(operation['responses'] !== undefined ? { responses: operation['responses'] } : {}),
        security: toArray(security),
      });
    }
  }

  return { operations, diagnostics };
}

/**
 * `operationId` if it survives normalisation, otherwise `method_path`.
 *
 * No counters and no random suffixes: two runs over the same document must
 * produce the same ids, and a collision is reported rather than papered over.
 */
function toResourceId(
  operationId: string | undefined,
  method: BackendMethod,
  path: string,
): string {
  const fromOperationId = operationId === undefined ? '' : normaliseId(operationId);
  if (fromOperationId !== '') return fromOperationId;
  return normaliseId(`${method.toLowerCase()}_${path}`);
}

function normaliseId(value: string): string {
  return value
    .replace(ID_ALLOWED, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '')
    .slice(0, MAX_ID_LENGTH);
}

/**
 * `--base-url` > operation servers > path-item servers > root servers.
 *
 * A relative server URL (`/v1`, the OpenAPI default of `/`) names no host, and
 * guessing one from the filename or from localhost would silently point a
 * merchant's gateway at the wrong backend — so it is refused and `--base-url`
 * asked for instead.
 */
function selectServer(
  document: Record<string, unknown>,
  candidates: readonly unknown[],
  context: { readonly where: string; readonly resourceId: string },
  options: DiscoverOptions,
  diagnostics: ImportDiagnostic[],
): string | undefined {
  if (options.baseUrl !== undefined) return options.baseUrl;

  for (const candidate of candidates) {
    const servers = toArray(candidate);
    const first = servers.length > 0 ? dereference(document, servers[0]).value : undefined;
    if (!isRecord(first)) continue;
    const url = first['url'];
    if (typeof url !== 'string' || url === '') continue;

    const substituted = substituteServerVariables(url, first['variables'], context, diagnostics);
    if (substituted === undefined) return undefined;
    if (!isAbsoluteHttpUrl(substituted)) {
      diagnostics.push({
        severity: 'error',
        code: 'relative-server-url',
        operation: context.resourceId,
        message: `Skipped ${context.where}: server URL "${substituted}" is relative, so no backend host is known. Pass --base-url`,
      });
      return undefined;
    }
    return substituted;
  }

  diagnostics.push({
    severity: 'error',
    code: 'no-server-url',
    operation: context.resourceId,
    message: `Skipped ${context.where}: the document declares no server URL. Pass --base-url`,
  });
  return undefined;
}

function substituteServerVariables(
  url: string,
  variables: unknown,
  context: { readonly where: string; readonly resourceId: string },
  diagnostics: ImportDiagnostic[],
): string | undefined {
  if (!url.includes('{')) return url;
  const declared = isRecord(variables) ? variables : {};
  const used: string[] = [];
  let missing: string | undefined;
  const substituted = url.replace(/\{([^{}]*)\}/g, (match, name: string) => {
    const variable = declared[name];
    const fallback = isRecord(variable) ? variable['default'] : undefined;
    if (typeof fallback !== 'string') {
      missing = name;
      return match;
    }
    used.push(`${name}=${fallback}`);
    return fallback;
  });
  if (missing !== undefined) {
    diagnostics.push({
      severity: 'error',
      code: 'server-variable-without-default',
      operation: context.resourceId,
      message: `Skipped ${context.where}: server variable "{${missing}}" has no default value. Pass --base-url`,
    });
    return undefined;
  }
  if (used.length > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'server-variable-default',
      operation: context.resourceId,
      message: `Server URL for ${context.where} uses declared defaults (${used.join(', ')}); override with --base-url if that is not the deployment you mean`,
    });
  }
  return substituted;
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function assertAbsoluteHttpUrl(value: string, label: string): void {
  if (!isAbsoluteHttpUrl(value)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `${label} "${value}" must be an absolute http:// or https:// URL`,
      { details: { value } },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
