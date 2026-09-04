/**
 * Reads and validates a local OpenAPI description.
 *
 * Offline by construction: the document is parsed here, every `$ref` is
 * checked to be internal *before* the validator ever sees the document, and no
 * URL-fetching plugin is passed to it. The importer must not turn "point it at
 * your API description" into "the gateway machine makes outbound requests to
 * whatever the file names".
 */
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { validate } from '@scalar/openapi-parser';
import { parse as parseYaml } from 'yaml';
import { CommerceError } from '../core/errors/index.js';
import type { LoadedOpenApiDocument, OpenApiVersion } from './types.js';

/** Generous for a hand-written description; small enough that a stray file is refused. */
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

const SUPPORTED_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);
const SUPPORTED_VERSIONS: ReadonlySet<string> = new Set(['3.0', '3.1', '3.2']);

function invalid(
  message: string,
  details: Record<string, unknown>,
  cause?: unknown,
): CommerceError {
  return new CommerceError('CONFIG_INVALID', message, {
    details,
    ...(cause !== undefined ? { cause } : {}),
  });
}

export async function loadOpenApiDocument(sourcePath: string): Promise<LoadedOpenApiDocument> {
  const details = { sourcePath };

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(sourcePath);
  } catch (error) {
    throw invalid(`OpenAPI document "${sourcePath}" could not be read`, details, error);
  }
  if (stats.isDirectory()) {
    throw invalid(`"${sourcePath}" is a directory, not an OpenAPI document`, details);
  }
  if (stats.size > MAX_SOURCE_BYTES) {
    throw invalid(
      `OpenAPI document "${sourcePath}" is ${stats.size} bytes, over the ${MAX_SOURCE_BYTES}-byte limit`,
      { ...details, size: stats.size, maxBytes: MAX_SOURCE_BYTES },
    );
  }

  const extension = extname(sourcePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw invalid(
      `OpenAPI document "${sourcePath}" has an unsupported extension "${extension || '(none)'}". Supported: .yaml, .yml, .json`,
      details,
    );
  }

  const source = await readFile(sourcePath, 'utf8');
  if (source.trim() === '') {
    throw invalid(`OpenAPI document "${sourcePath}" is empty`, details);
  }

  let parsed: unknown;
  try {
    // YAML is a superset of JSON, but JSON.parse gives the better message for a
    // file that claims to be JSON, and refuses YAML that a .json file should
    // not contain.
    parsed = extension === '.json' ? JSON.parse(source) : parseYaml(source);
  } catch (error) {
    throw invalid(
      `OpenAPI document "${sourcePath}" is not valid ${extension === '.json' ? 'JSON' : 'YAML'}: ${error instanceof Error ? error.message : String(error)}`,
      details,
      error,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid(`OpenAPI document "${sourcePath}" is not an object`, details);
  }
  const document = parsed as Record<string, unknown>;

  const version = readVersion(document, sourcePath);
  // Before validation, not after: the validator resolves references, and the
  // no-network guarantee is only worth something if nothing external ever
  // reaches it.
  rejectExternalReferences(document, sourcePath);

  const result = await validate(document);
  if (!result.valid) {
    const first = result.errors?.[0];
    throw invalid(
      `OpenAPI document "${sourcePath}" is not a valid OpenAPI ${version} description: ${first ? `${first.message}${first.path ? ` (at ${first.path})` : ''}` : 'unknown validation error'}`,
      { ...details, errors: result.errors?.slice(0, 10) ?? [] },
    );
  }

  return { version, document, sourcePath };
}

/**
 * The `openapi` field decides, not the validator's own verdict: the validator
 * happily calls a Swagger 2.0 document valid, and importing one would mean
 * `host`/`basePath`/`schemes` and body-parameter conversion semantics that
 * nothing downstream understands. Refuse it by name so the operator is told to
 * convert rather than left guessing.
 */
function readVersion(document: Record<string, unknown>, sourcePath: string): OpenApiVersion {
  const details = { sourcePath };
  if (typeof document['swagger'] === 'string') {
    throw invalid(
      `"${sourcePath}" is a Swagger ${document['swagger']} document. Only OpenAPI 3.0, 3.1 and 3.2 are supported - convert it first`,
      details,
    );
  }
  const declared = document['openapi'];
  if (typeof declared !== 'string') {
    throw invalid(`"${sourcePath}" has no "openapi" version field`, details);
  }
  const featureVersion = /^(\d+\.\d+)(?:\.|$)/.exec(declared)?.[1];
  if (featureVersion === undefined || !SUPPORTED_VERSIONS.has(featureVersion)) {
    throw invalid(
      `OpenAPI version "${declared}" is not supported. Supported: 3.0.x, 3.1.x, 3.2.x`,
      { ...details, version: declared },
    );
  }
  return featureVersion as OpenApiVersion;
}

/**
 * An external `$ref` is refused rather than fetched or read from disk. Both
 * would be the importer acting on behalf of a document it was merely asked to
 * read - one as an outbound request from wherever the CLI runs, the other as a
 * filesystem read outside the source file. Multi-file descriptions are a later
 * feature; until then, saying so beats a silent partial import.
 */
function rejectExternalReferences(document: Record<string, unknown>, sourcePath: string): void {
  // Iterative with a seen set: YAML aliases can make the parsed graph cyclic,
  // and a deeply nested document would otherwise blow the call stack.
  const seen = new WeakSet<object>();
  const queue: unknown[] = [document];
  while (queue.length > 0) {
    const node = queue.pop();
    if (typeof node !== 'object' || node === null) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      queue.push(...node);
      continue;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string' && !value.startsWith('#')) {
        throw invalid(
          `OpenAPI document "${sourcePath}" contains an external reference "${value}". Only internal references (#/...) are supported; the importer performs no network or filesystem lookups`,
          { sourcePath, ref: value },
        );
      }
      queue.push(value);
    }
  }
}
