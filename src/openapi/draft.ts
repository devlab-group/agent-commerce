/**
 * Operation candidates -> Agent Commerce resource drafts.
 *
 * A draft describes the *API shape* and nothing else. Pricing, exposure and
 * payment methods are commerce policy: an OpenAPI document has no opinion on
 * whether an operation should cost money or be visible to agents, so guessing
 * one would put a merchant's endpoint on an agent network - or give it away
 * free - on the strength of a file that never mentioned either. Without
 * explicit CLI policy the generated file is deliberately incomplete: it will
 * not load until a human fills those fields in.
 */
import { Document, type Node, type Pair, type YAMLMap } from 'yaml';
import type { JsonSchema } from '../core/domain/common.js';
import { discoverOperations } from './discover.js';
import { mapRequest, pickJsonMediaType } from './request.js';
import { convertSchema } from './schema.js';
import type {
  ImportDiagnostic,
  LoadedOpenApiDocument,
  OpenApiOperationCandidate,
  OpenApiVersion,
} from './types.js';

/** Commerce policy the operator supplied explicitly. Never inferred. */
export interface ImportPolicy {
  readonly pricing?: Record<string, unknown>;
  readonly expose?: readonly string[];
  readonly payments?: readonly string[];
}

export interface ImportOptions {
  readonly baseUrl?: string;
  readonly policy?: ImportPolicy;
  /** `--operation` / `--tag`. Applied before mapping, so unselected operations produce no noise. */
  readonly include?: {
    readonly operationIds?: readonly string[];
    /** Multiple tags are OR-ed. */
    readonly tags?: readonly string[];
  };
}

export interface ResourceDraft {
  readonly id: string;
  readonly operationId?: string;
  readonly tags: readonly string[];
  /** `METHOD /path`, for the console summary. */
  readonly source: string;
  /** YAML-ready, in the field order it will be written in. */
  readonly resource: Record<string, unknown>;
  /** Comment lines written above this resource. */
  readonly review: readonly string[];
}

export interface ImportResult {
  readonly version: OpenApiVersion;
  readonly sourcePath: string;
  readonly drafts: readonly ResourceDraft[];
  readonly diagnostics: readonly ImportDiagnostic[];
  /** `--operation` values that matched nothing. The CLI exits non-zero on these. */
  readonly unmatchedOperationIds: readonly string[];
}

export function buildResourceDrafts(
  loaded: LoadedOpenApiDocument,
  options: ImportOptions = {},
): ImportResult {
  const discovery = discoverOperations(
    loaded,
    options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {},
  );
  const diagnostics: ImportDiagnostic[] = [...discovery.diagnostics];
  const drafts: ResourceDraft[] = [];

  const wanted = options.include?.operationIds;
  const wantedTags = options.include?.tags;
  const matched = new Set<string>();

  for (const candidate of discovery.operations) {
    if (wanted !== undefined && !selects(wanted, candidate)) continue;
    if (wantedTags !== undefined && !candidate.tags.some((tag) => wantedTags.includes(tag))) {
      continue;
    }
    if (wanted !== undefined) {
      for (const id of wanted) if (selects([id], candidate)) matched.add(id);
    }

    const mapping = mapRequest(loaded, candidate);
    diagnostics.push(...mapping.diagnostics);
    if (!mapping.supported) continue;

    const dropped = new Set(mapping.droppedKeywords);
    const output = selectOutputSchema(loaded.document, candidate, diagnostics, dropped);
    if (dropped.size > 0) {
      diagnostics.push({
        severity: 'warning',
        code: 'unenforced-schema-constraints',
        operation: candidate.resourceId,
        message: `${candidate.resourceId}: dropped ${[...dropped].join(', ')} - this gateway validates structure only, and keeping them would advertise checks it never performs`,
      });
    }

    const review: string[] = [];
    if (declaresSecurity(candidate)) {
      diagnostics.push({
        severity: 'warning',
        code: 'backend-authentication-required',
        operation: candidate.resourceId,
        message: `${candidate.resourceId} declares backend authentication. OpenAPI credentials were not imported. Configure backend.headers with environment placeholders before enabling the resource`,
      });
      review.push(
        'This operation declares backend authentication. No credential was imported.',
        'Add it under backend.headers with an ${ENV_VAR} placeholder before enabling.',
      );
    }
    if (options.policy?.pricing === undefined || options.policy.expose === undefined) {
      review.push(
        'REVIEW: pricing and exposure are not inferred from OpenAPI. Add e.g.',
        '  pricing: { type: free }   # or { type: fixed, amount: "0.01", currency: USDC }',
        '  expose: [http]           # http | mcp | a2a',
      );
    }

    drafts.push({
      id: candidate.resourceId,
      ...(candidate.operationId !== undefined ? { operationId: candidate.operationId } : {}),
      tags: candidate.tags,
      source: `${candidate.method} ${candidate.path}`,
      resource: {
        name: candidate.name,
        ...(candidate.description !== undefined ? { description: candidate.description } : {}),
        input: mapping.inputSchema,
        ...(output !== undefined ? { output } : {}),
        backend: {
          type: 'http',
          method: candidate.method,
          url: candidate.backendUrl,
          ...(mapping.contentType !== undefined
            ? { headers: { 'Content-Type': mapping.contentType } }
            : {}),
          ...(Object.keys(mapping.inputBindings).length > 0
            ? { inputBindings: mapping.inputBindings }
            : {}),
        },
        // Policy is written only when the operator asked for it. An absent
        // `pricing`/`expose` is what makes the draft fail config validation
        // until a human has decided.
        ...(options.policy?.pricing !== undefined ? { pricing: options.policy.pricing } : {}),
        ...(options.policy?.expose !== undefined ? { expose: [...options.policy.expose] } : {}),
        ...(options.policy?.payments !== undefined
          ? { payments: [...options.policy.payments] }
          : {}),
      },
      review,
    });
  }

  return {
    version: loaded.version,
    sourcePath: loaded.sourcePath,
    drafts,
    diagnostics,
    unmatchedOperationIds: (wanted ?? []).filter((id) => !matched.has(id)),
  };
}

/** `--operation` accepts the OpenAPI operationId or the generated resource id. */
function selects(ids: readonly string[], candidate: OpenApiOperationCandidate): boolean {
  return (
    ids.includes(candidate.resourceId) ||
    (candidate.operationId !== undefined && ids.includes(candidate.operationId))
  );
}

/** `security: []` means "explicitly none"; `[{}]` means optional. Neither needs a credential. */
function declaresSecurity(candidate: OpenApiOperationCandidate): boolean {
  return candidate.security.some(
    (requirement) =>
      typeof requirement === 'object' &&
      requirement !== null &&
      Object.keys(requirement).length > 0,
  );
}

/**
 * One success response, chosen the same way every run: 200, then 201, then
 * 202, then the remaining explicit 2xx in ascending order. Status-dependent
 * unions are out of scope, so when several 2xx carry materially different
 * schemas the operator is told which one was taken rather than left to
 * discover it from the diff.
 */
function selectOutputSchema(
  document: Record<string, unknown>,
  candidate: OpenApiOperationCandidate,
  diagnostics: ImportDiagnostic[],
  dropped: Set<string>,
): JsonSchema | undefined {
  const responses = candidate.responses;
  if (!isRecord(responses)) return undefined;

  const successes = Object.keys(responses)
    .filter((status) => /^2\d\d$/.test(status))
    .sort((a, b) => rank(a) - rank(b));
  if (successes.length === 0) return undefined;

  const withBody = successes.filter((status) => {
    const response = responses[status];
    const content = isRecord(response) ? response['content'] : undefined;
    return isRecord(content) && pickJsonMediaType(Object.keys(content)) !== undefined;
  });
  const chosen = withBody[0];
  if (chosen === undefined) return undefined; // 204, or no JSON representation

  const response = responses[chosen] as Record<string, unknown>;
  const content = response['content'] as Record<string, unknown>;
  const mediaType = pickJsonMediaType(Object.keys(content)) as string;
  const media = content[mediaType];
  const schemaNode = isRecord(media) ? media['schema'] : undefined;
  if (schemaNode === undefined) return undefined;

  const converted = convertSchema(document, schemaNode);
  if (!converted.supported) {
    // Output schema is descriptive: omitting it costs discovery detail, not
    // request safety, so it never skips the operation.
    diagnostics.push({
      severity: 'warning',
      code: 'unsupported-output-schema',
      operation: candidate.resourceId,
      message: `${candidate.resourceId}: omitted the output schema (${converted.reason})`,
    });
    return undefined;
  }
  for (const keyword of converted.dropped) dropped.add(keyword);

  if (withBody.length > 1) {
    diagnostics.push({
      severity: 'warning',
      code: 'multiple-success-responses',
      operation: candidate.resourceId,
      message: `${candidate.resourceId}: responses ${withBody.join(', ')} all carry a JSON body; used ${chosen}`,
    });
  }
  return converted.schema;
}

function rank(status: string): number {
  const preferred = ['200', '201', '202'].indexOf(status);
  return preferred === -1 ? 100 + Number(status) : preferred;
}

/**
 * Renders the drafts as a config fragment: the same `resources:` shape
 * `config.yaml` uses, so a reviewed block can be moved across whole.
 */
export function renderResourcesYaml(result: ImportResult): string {
  const resources: Record<string, unknown> = {};
  for (const draft of result.drafts) resources[draft.id] = draft.resource;

  const doc = new Document({ resources });
  doc.commentBefore = [
    ' Generated by agent-commerce import openapi. Review before use.',
    ` Source: ${basename(result.sourcePath)} (OpenAPI ${result.version})`,
    ' Merge the resources below into config.yaml once pricing, exposure and',
    ' any backend authentication have been decided.',
  ].join('\n');

  // Comments hang off the key node; a Pair has nowhere to put one. Map items
  // are in insertion order, which is draft order.
  const map = doc.getIn(['resources'], true) as YAMLMap | undefined;
  map?.items.forEach((item, index) => {
    const draft = result.drafts[index];
    const key = (item as Pair<Node, unknown>).key;
    if (draft === undefined || draft.review.length === 0 || key === null) return;
    key.commentBefore = draft.review.map((line) => ` ${line}`).join('\n');
  });

  // lineWidth 0 disables folding: a wrapped description would otherwise
  // re-flow whenever an unrelated word changed, and the generated file is
  // meant to be reviewed in a diff.
  return doc.toString({ lineWidth: 0 });
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
