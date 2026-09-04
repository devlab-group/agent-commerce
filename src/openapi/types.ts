/**
 * Importer-internal types.
 *
 * Nothing here is part of the frozen contract, and nothing here may leak into
 * `src/core`: OpenAPI is an import/config concern, so it terminates at the
 * canonical resource/config boundary rather than travelling into the runtime.
 */
import type { BackendMethod } from '../core/domain/resource.js';

/** OpenAPI feature versions this importer understands. Patch level is ignored. */
export type OpenApiVersion = '3.0' | '3.1' | '3.2';

export interface LoadedOpenApiDocument {
  readonly version: OpenApiVersion;
  /** The source document, verbatim. References are resolved lazily, never up front. */
  readonly document: Record<string, unknown>;
  readonly sourcePath: string;
}

/**
 * Structured import findings.
 *
 * Converters return these instead of printing: the CLI decides what a warning
 * looks like and whether `--strict` turns one into a non-zero exit, and the
 * tests can assert on codes rather than on console text.
 */
export interface ImportDiagnostic {
  readonly severity: 'warning' | 'error';
  readonly code: string;
  /** The resource id, or `METHOD path` when discovery failed before an id existed. */
  readonly operation?: string;
  readonly message: string;
}

/** One discovered OpenAPI operation, before schemas are converted (Phase 4). */
export interface OpenApiOperationCandidate {
  readonly resourceId: string;
  readonly method: BackendMethod;
  /** The OpenAPI path template, e.g. `/users/{userId}/orders`. */
  readonly path: string;
  /** Selected server + path, with `{param}` templates preserved literally. */
  readonly backendUrl: string;
  readonly operationId?: string;
  /** OpenAPI tags, verbatim - the CLI's `--tag` filter reads them. */
  readonly tags: readonly string[];
  readonly name: string;
  readonly description?: string;
  /** Path-item parameters first, then operation parameters - unresolved nodes. */
  readonly parameters: readonly unknown[];
  readonly requestBody?: unknown;
  readonly responses?: unknown;
  /** Effective security requirements (operation's own, else the document's). */
  readonly security: readonly unknown[];
}
