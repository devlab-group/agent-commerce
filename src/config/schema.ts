/**
 * `config.yaml` schema, validation and normalisation into the
 * canonical `GatewayConfig` (docs/contracts.md).
 *
 * Two-phase validation:
 * 1. Zod validates *shape* (types, required fields, unknown-key rejection).
 * Numeric/boolean leaves accept either their native type or a string
 * (env substitution always produces a string), and are left as-is here —
 * Zod's typed transforms have surprising inference interactions with
 * `.strict()` objects, so numeric/boolean coercion is done explicitly,
 * in plain TypeScript, in the normalisation pass below.
 * 2. A manual business-rule pass validates cross-references that need a
 * specific, actionable message (duplicate ids, disabled protocols/payment
 * methods, dynamic pricing, destination-address plausibility) and
 * performs the numeric/boolean coercion.
 *
 * Env substitution (`${VAR}` / `${VAR:-default}`) runs over the raw parsed
 * value *before* either phase, so numeric/boolean fields can be templated too.
 * One exception, deliberate: `checkVersion` runs **before** substitution, so
 * `version:` cannot itself be templated. It is the compatibility gate that
 * decides whether this parser understands the document at all; resolving
 * environment variables to find out which schema version to expect would be
 * backwards. The order is intended; `version:` is the one exception to the
 * substitution rule, which this sentence exists to record.
 */

import { type ZodError, type ZodIssue, type ZodTypeAny, z } from 'zod';
import {
  extractPathParameterNames,
  findUnparsedBraceToken,
  isObjectSchemaNode,
} from '../core/execution/index.js';
import {
  CommerceError,
  type CommerceResource,
  PAYMENT_INPUT_FIELD,
  type Pricing,
} from '../core/index.js';
import { resolveX402Deployment, type X402FacilitatorConfig } from '../payments/x402/guardrails.js';
import { substituteEnv } from './env.js';

const SUPPORTED_CONFIG_VERSION = 1;

/** `0x` + 40 hex chars. Checksum-insensitive: casing is not enforced. */
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS_PATTERN = /^0x0{40}$/i;

/**
 * A resource `id` doubles as its MCP tool name (protocol-mcp registers one
 * tool per resource, named by id). Value verified against the regex actually
 * shipped in the installed `@modelcontextprotocol/sdk@1.30.0`
 * (`shared/toolNameValidation.js`, SEP-986 "Specify Format for Tool Names") —
 * not duplicated as an SDK dependency, since config stays protocol-agnostic.
 */
const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

// ---------------------------------------------------------------------------
// Zod schema for the *shape* of the raw (post-substitution) document.
// ---------------------------------------------------------------------------

/** Accepts a real number or a (post env-substitution) numeric string. */
const NumberOrString = z.union([z.number(), z.string()]);
/** Accepts a real boolean or a (post env-substitution) "true"/"false" string. */
const BooleanOrString = z.union([z.boolean(), z.string()]);

const MerchantSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    publicBaseUrl: z.string().min(1),
  })
  .strict();

const ServerSchema = z
  .object({
    port: NumberOrString,
    host: z.string().min(1),
    /** Shared secret gating /api/receipts, /api/events, /api/events/stream. No token -> those routes 404. */
    adminToken: z.string().min(1).optional(),
    /** Browser origins allowed to read the dashboard-facing routes. Empty by default: closed. */
    // Entries are matched literally against the browser's
    // `Origin` header, so `"*"` and a trailing slash match nothing at all —
    // fail-closed (a lockout, not a bypass), but silently, and a lockout with
    // no explanation is the kind of thing an operator "fixes" by disabling the
    // check. Reject those two shapes with a pointer instead.
    allowedOrigins: z
      .array(
        z
          .string()
          .min(1)
          .refine((origin) => origin !== '*', {
            message:
              'wildcard "*" is not supported — allowedOrigins entries are matched literally against the browser\'s Origin header, so "*" would match nothing. List each scheme://host[:port] explicitly.',
          })
          .refine((origin) => !origin.endsWith('/'), {
            message:
              'must not end with "/" — a browser Origin header never has a trailing slash, so this entry would match nothing. Use e.g. "http://localhost:5173".',
          }),
      )
      .optional(),
  })
  .strict();

const StorageSchema = z
  .object({
    receipts: z
      .object({
        driver: z.literal('sqlite'),
        path: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const ProtocolsSchema = z
  .object({
    http: z.object({ enabled: BooleanOrString }).strict(),
    mcp: z
      .object({
        enabled: BooleanOrString,
        mountPath: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const BackendMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

const BackendHandlerSchema = z
  .object({
    type: z.literal('http'),
    method: BackendMethodSchema,
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    timeoutMs: NumberOrString.optional(),
  })
  .strict();

const PricingSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('free') }).strict(),
  z
    .object({
      type: z.literal('fixed'),
      amount: z.string().min(1),
      currency: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('dynamic'),
      resolver: z.string().min(1),
    })
    .strict(),
]);

const JsonSchemaValueSchema: ZodTypeAny = z.record(z.string(), z.unknown());

const ResourceEntrySchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    input: JsonSchemaValueSchema.optional(),
    output: JsonSchemaValueSchema.optional(),
    backend: BackendHandlerSchema,
    pricing: PricingSchema,
    expose: z.array(z.string().min(1)).min(1),
    payments: z.array(z.string().min(1)).optional(),
  })
  .strict();

const ResourcesMapSchema = z.record(z.string().min(1), ResourceEntrySchema);

/**
 * Facilitator credentials, kept generic on purpose: x402 facilitators are not
 * a single-vendor category, and an auth block shaped around one provider's
 * credentials would make the abstraction a fiction. A facilitator needing
 * per-request signed credentials is refused rather than sent nothing.
 */
const FacilitatorAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('bearer'), token: z.string().min(1) }).strict(),
  // Coinbase Developer Platform. Needs the optional peer `@coinbase/x402`,
  // which signs a fresh JWT per request; a static header cannot express it.
  z
    .object({
      type: z.literal('cdp'),
      apiKeyId: z.string().min(1),
      apiKeySecret: z.string().min(1),
    })
    .strict(),
]);

const FacilitatorSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('local'),
      signerPrivateKey: z.string().min(1),
    })
    .strict(),
  z
    .object({
      mode: z.literal('remote'),
      url: z.string().min(1),
      // Absent means "this facilitator takes no credential" — an explicit
      // statement, normalised to `{ type: 'none' }` below. On a mainnet that
      // combination is refused outright, so the default can never quietly
      // become an unauthenticated production facilitator.
      auth: FacilitatorAuthSchema.optional(),
    })
    .strict(),
]);

const X402Schema = z
  .object({
    enabled: BooleanOrString,
    network: z.string().min(1),
    rpcUrl: z.string().min(1),
    asset: z.string().min(1),
    assetName: z.string().min(1),
    assetVersion: z.string().min(1),
    assetDecimals: NumberOrString,
    payTo: z.string().min(1),
    maxTimeoutSeconds: NumberOrString,
    facilitator: FacilitatorSchema,
    /** Real funds. Never defaulted — see src/payments/x402/guardrails.ts. */
    allowMainnet: BooleanOrString.optional(),
    /** Accepts a mainnet facilitator that takes no credential. Never defaulted. */
    allowUnauthenticatedFacilitator: BooleanOrString.optional(),
  })
  .strict();

const PaymentsSchema = z
  .object({
    x402: X402Schema.optional(),
  })
  .strict();

const RawConfigSchema = z
  .object({
    version: z.literal(SUPPORTED_CONFIG_VERSION),
    merchant: MerchantSchema,
    server: ServerSchema,
    storage: StorageSchema,
    protocols: ProtocolsSchema,
    resources: ResourcesMapSchema,
    payments: PaymentsSchema,
  })
  .strict();

type RawConfig = z.infer<typeof RawConfigSchema>;
type RawResourceEntry = z.infer<typeof ResourceEntrySchema>;

// ---------------------------------------------------------------------------
// Public shape (docs/contracts.md — exact).
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  readonly version: 1;
  readonly merchant: { readonly id: string; readonly name: string; readonly publicBaseUrl: string };
  readonly server: {
    readonly port: number;
    readonly host: string;
    readonly adminToken?: string;
    readonly allowedOrigins: readonly string[];
  };
  readonly storage: { readonly receipts: { readonly driver: 'sqlite'; readonly path: string } };
  readonly protocols: {
    readonly http: { readonly enabled: boolean };
    readonly mcp: { readonly enabled: boolean; readonly mountPath: string };
  };
  /** Canonical resources, already normalised. */
  readonly resources: readonly CommerceResource[];
  readonly payments: {
    readonly x402?: {
      readonly enabled: boolean;
      readonly network: string;
      readonly rpcUrl: string;
      readonly asset: string;
      readonly assetName: string;
      readonly assetVersion: string;
      readonly assetDecimals: number;
      readonly payTo: string;
      readonly maxTimeoutSeconds: number;
      readonly facilitator: X402FacilitatorConfig;
      readonly allowMainnet?: boolean;
      readonly allowUnauthenticatedFacilitator?: boolean;
    };
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv): GatewayConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      'Configuration root must be a mapping (object) at "$"',
      {
        details: { path: '$' },
      },
    );
  }

  checkVersion(raw as Record<string, unknown>);

  const substituted = substituteEnv(raw, env);
  const parsed = parseWithZod(RawConfigSchema, substituted);
  return normalise(parsed);
}

function checkVersion(raw: Record<string, unknown>): void {
  if (!('version' in raw)) {
    throw new CommerceError('CONFIG_INVALID', 'Configuration is missing required field "version"', {
      details: { path: 'version' },
    });
  }
  const rawVersion = raw['version'];
  const version = typeof rawVersion === 'string' ? Number(rawVersion) : rawVersion;
  if (version !== SUPPORTED_CONFIG_VERSION) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Unsupported config version "${String(rawVersion)}": this gateway only supports version ${SUPPORTED_CONFIG_VERSION}`,
      { details: { path: 'version', supported: SUPPORTED_CONFIG_VERSION } },
    );
  }
}

function parseWithZod<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw zodErrorToConfigError(result.error);
  }
  return result.data;
}

function zodErrorToConfigError(error: ZodError): CommerceError {
  const issues = error.issues.map(describeIssue);
  const first = issues[0];
  const message = first
    ? `Configuration invalid at "${first.path}": ${first.message}`
    : 'Configuration invalid';
  return new CommerceError('CONFIG_INVALID', message, { details: { issues } });
}

function describeIssue(issue: ZodIssue): { path: string; message: string; code: string } {
  const path = issue.path.length > 0 ? issue.path.join('.') : '$';
  return { path, message: issue.message, code: issue.code };
}

// ---------------------------------------------------------------------------
// Numeric / boolean coercion (explicit, not via Zod — see file header).
// ---------------------------------------------------------------------------

function toNumber(
  value: number | string,
  path: string,
  bounds: { min?: number; max?: number } = {},
): number {
  // `Number('')` is 0 — finite, integral, and inside
  // `server.port`'s deliberate `min: 0` ("let the OS pick"). So `port: ${PORT:-}`
  // or an exported-but-empty PORT validated PASS and the gateway bound a random
  // port, after which `doctor` derived `http://127.0.0.1:0`, failed to connect,
  // and reported the gateway unreachable while it was serving. `Number` also
  // accepts `"0x50"` (80) and `"1e3"` (1000) for fields that are decimal
  // integers everywhere they are documented. Require plain digits instead.
  if (typeof value === 'string' && !/^\s*\d+\s*$/.test(value)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Configuration value at "${path}" must be an integer written in decimal digits (got ${value === '' ? 'an empty string' : `"${value}"`})`,
      { details: { path } },
    );
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Configuration value at "${path}" must be an integer`,
      {
        details: { path },
      },
    );
  }
  if (bounds.min !== undefined && n < bounds.min) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Configuration value at "${path}" must be >= ${bounds.min}`,
      {
        details: { path },
      },
    );
  }
  if (bounds.max !== undefined && n > bounds.max) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Configuration value at "${path}" must be <= ${bounds.max}`,
      {
        details: { path },
      },
    );
  }
  return n;
}

function toBoolean(value: boolean | string, path: string): boolean {
  if (typeof value === 'boolean') return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new CommerceError(
    'CONFIG_INVALID',
    `Configuration value at "${path}" must be a boolean ("true" or "false")`,
    { details: { path } },
  );
}

// ---------------------------------------------------------------------------
// Business-rule validation + normalisation into the canonical shape.
// ---------------------------------------------------------------------------

const SUPPORTED_PROTOCOLS = new Set(['http', 'mcp']);
const SUPPORTED_PAYMENT_METHODS = new Set(['x402']);

function normalise(raw: RawConfig): GatewayConfig {
  const protocols = {
    http: { enabled: toBoolean(raw.protocols.http.enabled, 'protocols.http.enabled') },
    mcp: {
      enabled: toBoolean(raw.protocols.mcp.enabled, 'protocols.mcp.enabled'),
      mountPath: raw.protocols.mcp.mountPath,
    },
  };

  const x402Raw = raw.payments.x402;
  const facilitator: X402FacilitatorConfig | undefined =
    x402Raw === undefined
      ? undefined
      : x402Raw.facilitator.mode === 'local'
        ? { mode: 'local', signerPrivateKey: x402Raw.facilitator.signerPrivateKey }
        : {
            mode: 'remote',
            url: x402Raw.facilitator.url,
            auth: x402Raw.facilitator.auth ?? { type: 'none' },
          };
  const x402 =
    x402Raw && facilitator
      ? {
          enabled: toBoolean(x402Raw.enabled, 'payments.x402.enabled'),
          network: x402Raw.network,
          rpcUrl: x402Raw.rpcUrl,
          asset: x402Raw.asset,
          assetName: x402Raw.assetName,
          assetVersion: x402Raw.assetVersion,
          assetDecimals: toNumber(x402Raw.assetDecimals, 'payments.x402.assetDecimals', {
            min: 0,
            max: 36,
          }),
          payTo: x402Raw.payTo,
          maxTimeoutSeconds: toNumber(
            x402Raw.maxTimeoutSeconds,
            'payments.x402.maxTimeoutSeconds',
            {
              min: 1,
            },
          ),
          facilitator,
          ...(x402Raw.allowMainnet !== undefined
            ? { allowMainnet: toBoolean(x402Raw.allowMainnet, 'payments.x402.allowMainnet') }
            : {}),
          ...(x402Raw.allowUnauthenticatedFacilitator !== undefined
            ? {
                allowUnauthenticatedFacilitator: toBoolean(
                  x402Raw.allowUnauthenticatedFacilitator,
                  'payments.x402.allowUnauthenticatedFacilitator',
                ),
              }
            : {}),
        }
      : undefined;

  if (x402) {
    validateAddress('payments.x402.payTo', x402.payTo);
    validateAddress('payments.x402.asset', x402.asset);
    // The same call the provider makes at construction, run here so
    // `agent-commerce validate` reports an unsafe deployment where an operator
    // expects to hear about it, rather than at first boot.
    resolveX402Deployment({
      network: x402.network,
      payTo: x402.payTo,
      asset: x402.asset,
      assetName: x402.assetName,
      assetVersion: x402.assetVersion,
      facilitator: x402.facilitator,
      ...(x402.allowMainnet !== undefined ? { allowMainnet: x402.allowMainnet } : {}),
      ...(x402.allowUnauthenticatedFacilitator !== undefined
        ? { allowUnauthenticatedFacilitator: x402.allowUnauthenticatedFacilitator }
        : {}),
    });
  }

  const resources = Object.entries(raw.resources).map(([id, entry]) =>
    normaliseResource(id, entry, protocols, x402),
  );

  return {
    version: SUPPORTED_CONFIG_VERSION,
    merchant: {
      id: raw.merchant.id,
      name: raw.merchant.name,
      publicBaseUrl: raw.merchant.publicBaseUrl,
    },
    // min 0, not 1: port 0 is the standard "let the OS pick a free port"
    // convention, useful for tests and ephemeral dev/demo instances.
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
      ...(x402 !== undefined ? { x402 } : {}),
    },
  };
}

interface NormalisedProtocols {
  readonly http: { readonly enabled: boolean };
  readonly mcp: { readonly enabled: boolean; readonly mountPath: string };
}

interface NormalisedX402 {
  readonly enabled: boolean;
  readonly assetDecimals: number;
}

function normaliseResource(
  id: string,
  entry: RawResourceEntry,
  protocols: NormalisedProtocols,
  x402: NormalisedX402 | undefined,
): CommerceResource {
  if (entry.input !== undefined) validateResourceSchemaKeywords(id, 'input', entry.input);

  const inputProperties = entry.input?.['properties'];
  if (
    inputProperties &&
    typeof inputProperties === 'object' &&
    PAYMENT_INPUT_FIELD in inputProperties
  ) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" declares an input property "${PAYMENT_INPUT_FIELD}", which is reserved for payment proofs`,
      {
        details: {
          path: `resources.${id}.input.properties.${PAYMENT_INPUT_FIELD}`,
          resourceId: id,
        },
      },
    );
  }

  for (const protocol of entry.expose) {
    if (!SUPPORTED_PROTOCOLS.has(protocol)) {
      const hint = protocol === 'ucp' ? ' (UCP is planned, not supported in this release)' : '';
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" exposes unsupported protocol "${protocol}"${hint}. Supported: http, mcp.`,
        { details: { path: `resources.${id}.expose`, resourceId: id, protocol } },
      );
    }
  }
  if (entry.expose.includes('mcp')) {
    if (!protocols.mcp.enabled) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" is exposed via "mcp" but protocols.mcp.enabled is false`,
        { details: { path: `resources.${id}.expose`, resourceId: id } },
      );
    }
    if (!MCP_TOOL_NAME_PATTERN.test(id)) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" is exposed via "mcp" but its id is not a legal MCP tool name (allowed: A-Z, a-z, 0-9, "_", "-", ".", 1-128 chars)`,
        { details: { path: `resources.${id}`, resourceId: id } },
      );
    }
  }
  if (entry.expose.includes('http') && !protocols.http.enabled) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" is exposed via "http" but protocols.http.enabled is false`,
      { details: { path: `resources.${id}.expose`, resourceId: id } },
    );
  }

  validateBackendUrl(id, entry.backend.url);
  validatePathParametersDeclared(id, entry.backend.url, entry.input);

  if (entry.pricing.type === 'dynamic') {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" uses pricing.type "dynamic", which is not supported in this release`,
      { details: { path: `resources.${id}.pricing.type`, resourceId: id } },
    );
  }

  if (entry.pricing.type === 'fixed') {
    validatePricingAmount(id, entry.pricing.amount, x402);
  }

  const paymentMethods = entry.payments ?? [];

  if (entry.pricing.type === 'fixed') {
    if (paymentMethods.length === 0) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" has fixed pricing but declares no "payments" (a paid resource must name at least one payment method)`,
        { details: { path: `resources.${id}.payments`, resourceId: id } },
      );
    }
    for (const method of paymentMethods) {
      if (!SUPPORTED_PAYMENT_METHODS.has(method)) {
        throw new CommerceError(
          'CONFIG_INVALID',
          `Resource "${id}" names unsupported payment method "${method}". Supported: x402.`,
          { details: { path: `resources.${id}.payments`, resourceId: id, method } },
        );
      }
      if (method === 'x402' && (!x402 || !x402.enabled)) {
        throw new CommerceError(
          'CONFIG_INVALID',
          `Resource "${id}" names payment method "x402" which is not configured or not enabled under payments.x402`,
          { details: { path: `resources.${id}.payments`, resourceId: id, method } },
        );
      }
    }
  }

  const pricing: Pricing =
    entry.pricing.type === 'free'
      ? { type: 'free' }
      : { type: 'fixed', amount: entry.pricing.amount, currency: entry.pricing.currency };

  return {
    id,
    name: entry.name,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    inputSchema:
      entry.input !== undefined
        ? defaultClosedObjectSchema(entry.input)
        : EMPTY_CLOSED_OBJECT_SCHEMA,
    ...(entry.output !== undefined ? { outputSchema: entry.output } : {}),
    handler: {
      type: 'http',
      method: entry.backend.method,
      url: entry.backend.url,
      ...(entry.backend.headers !== undefined ? { headers: entry.backend.headers } : {}),
      ...(entry.backend.timeoutMs !== undefined
        ? {
            timeoutMs: toNumber(entry.backend.timeoutMs, `resources.${id}.backend.timeoutMs`, {
              min: 1,
            }),
          }
        : {}),
    },
    pricing,
    exposedVia: entry.expose as CommerceResource['exposedVia'],
    paymentMethods: paymentMethods as CommerceResource['paymentMethods'],
  };
}

/**
 * `{param}` templates (e.g. `.../weather/{city}`) parse fine as a URL — the
 * WHATWG parser just percent-encodes the braces — so this only rejects
 * genuinely malformed strings and non-http(s) schemes, not templating.
 */
/**
 * Permissive-by-default is the wrong default for a value forwarded to
 * someone else's API: an object schema that
 * omits `additionalProperties` defaults, per JSON Schema itself, to
 * "anything goes" — so default it to `false` here instead, unless the
 * operator set it explicitly (including explicitly to `true`, which is
 * respected).
 *
 * An earlier fix only stamped the ROOT schema, so
 * `filter: { type: object }` *looked* closed (the top level really was)
 * while every key one level down under `properties.filter` still passed
 * verbatim — `core`'s validator (execution/validation.ts) only enforces
 * `additionalProperties` where the schema states it explicitly, at every
 * level independently. Recurse into `properties` and `items` the same way
 * `validateResourceSchemaKeywords` below already does, so "closed" actually
 * means closed at every depth, not just the one an operator happened to
 * write `additionalProperties: false` on.
 *
 * `type` can be an array (`["object","null"]`, valid JSON
 * Schema) — a bare `=== 'object'` string comparison missed it, so a schema
 * in that shape got stamped as open. `declaresObjectType` below is the same
 * check `core`'s validator now makes (`execution/validation.ts`'s
 * `isObjectSchemaNode`) so the two stay in agreement.
 */
function defaultClosedObjectSchema(schema: Record<string, unknown>): Record<string, unknown> {
  // imported, never re-implemented. The local predicate this
  // replaces recognised `type`/`properties` but not `required`, while core's
  // validator recognised `properties`/`required` — so `input: { required: [q] }`
  // was an object to the validator and not to the stamper, and every unknown
  // key sailed through to the merchant backend. One definition, one drift.
  const isObjectSchema = isObjectSchemaNode(schema);
  const result: Record<string, unknown> = { ...schema };

  if (isObjectSchema) {
    const properties = schema['properties'];
    if (isPlainObject(properties)) {
      result['properties'] = Object.fromEntries(
        Object.entries(properties).map(([key, sub]) => [
          key,
          isPlainObject(sub) ? defaultClosedObjectSchema(sub) : sub,
        ]),
      );
    }
    if (!Object.hasOwn(schema, 'additionalProperties')) {
      result['additionalProperties'] = false;
    }
  }

  const items = schema['items'];
  if (isPlainObject(items)) {
    result['items'] = defaultClosedObjectSchema(items);
  }

  return result;
}

/**
 * A resource that declares no `input:` at all got
 * `inputSchema: undefined`, and `compileJsonSchema(undefined)` is an
 * always-valid validator — every caller key was forwarded to the merchant
 * backend verbatim. The decision: default "declared nothing" to "accepts
 * nothing" (an empty closed object) rather than rejecting the config at load
 * time — a no-argument resource that omits `input:` is a legitimate shape,
 * and rejecting it would break every existing config that uses it.
 */
const EMPTY_CLOSED_OBJECT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

/**
 * `src/core`'s validator only enforces the subset documented in
 * `execution/validation.ts` (type/properties/required/additionalProperties/
 * enum/items) — everything else (`pattern`, `minLength`, `format`, `oneOf`,
 * …) is silently ignored at runtime. An operator who writes `pattern` and
 * never sees it enforced has no way to know that from the config alone, so
 * warn at load time instead of letting them find out the hard way.
 */
const UNSUPPORTED_SCHEMA_KEYWORDS = [
  'pattern',
  'minLength',
  'maxLength',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  '$ref',
  'const',
  'patternProperties',
  'minItems',
  'maxItems',
  'uniqueItems',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `type` explicitly set to something that rules out "object" (a bare
 * value, or an array not containing "object"). `undefined` — no `type` at
 * all — is deliberately NOT treated as excluding: core's validator treats
 * `properties`/`required` with no `type` as an object schema, so that shape
 * is fine, not another instance of this bug. */
function excludesObjectType(schema: Record<string, unknown>): boolean {
  const type = schema['type'];
  if (type === undefined || type === 'object') return false;
  if (Array.isArray(type)) return !type.includes('object');
  return true;
}

/**
 * Walks a resource's input schema once, both warning (existing, unenforced
 * keywords) and rejecting (a node whose declared `type`
 * cannot structurally be an object, yet which still carries `properties` or
 * `required`). The `properties`/`required`-with-no-`type` shape is not
 * this function's problem any more, since the
 * validator now treats that shape as an object; what's still a trap is a
 * `type` that actively rules "object" out while `properties`/`required`
 * imply it was meant to be one, e.g. a copy-pasted sibling schema whose
 * `type` was never updated. Rejecting (not just warning) here is the
 * decision — a warning is exactly what let this bug class ship silently in
 * the first place (`validate`/`doctor` both said PASS).
 */
function validateResourceSchemaKeywords(
  id: string,
  path: string,
  schema: Record<string, unknown>,
): void {
  for (const keyword of UNSUPPORTED_SCHEMA_KEYWORDS) {
    if (Object.hasOwn(schema, keyword)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[agent-commerce] resource "${id}" ${path} uses JSON Schema keyword "${keyword}", which this gateway does not enforce (see src/core/execution/validation.ts for the supported subset). Remove it or treat it as documentation only.`,
      );
    }
  }
  if (
    (Object.hasOwn(schema, 'properties') || Object.hasOwn(schema, 'required')) &&
    excludesObjectType(schema)
  ) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" ${path} declares "properties" and/or "required" but its "type" (${JSON.stringify(schema['type'])}) does not include "object" — the validator will never route a value through either check under that type, so this schema claims to constrain input it does not actually enforce. Remove "properties"/"required", or include "object" in "type".`,
      { details: { path: `resources.${id}.${path}`, resourceId: id } },
    );
  }
  // the other half. Closing a `required`-only node is
  // correct JSON Schema and quietly unsatisfiable: `required: ["q"]` demands a
  // property that `properties` never declares, so the stamped
  // `additionalProperties: false` rejects `q` as an unknown key — the schema
  // can never be satisfied by any input at all. Fail-closed, so no money is at
  // risk, but every call would 400 with a config that loaded cleanly. Say so
  // at load instead. Only when the node really will be closed: an explicit
  // `additionalProperties` other than `false` leaves the name reachable.
  const requiredRaw = schema['required'];
  const closed = !Object.hasOwn(schema, 'additionalProperties')
    ? true
    : schema['additionalProperties'] === false;
  if (Array.isArray(requiredRaw) && closed && isObjectSchemaNode(schema)) {
    const declared = isPlainObject(schema['properties']) ? schema['properties'] : {};
    const undeclared = requiredRaw.filter(
      (name): name is string => typeof name === 'string' && !Object.hasOwn(declared, name),
    );
    if (undeclared.length > 0) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" ${path} lists ${undeclared.map((n) => `"${n}"`).join(', ')} in "required" but does not declare ${undeclared.length === 1 ? 'it' : 'them'} in "properties". The schema is closed (additionalProperties: false), so ${undeclared.length === 1 ? 'that name is' : 'those names are'} rejected as an unknown key and no input can ever satisfy this schema. Declare ${undeclared.length === 1 ? 'it' : 'them'} in "properties".`,
        { details: { path: `resources.${id}.${path}`, resourceId: id, undeclared } },
      );
    }
  }

  const properties = schema['properties'];
  if (isPlainObject(properties)) {
    for (const [key, sub] of Object.entries(properties)) {
      if (isPlainObject(sub)) validateResourceSchemaKeywords(id, `${path}.properties.${key}`, sub);
    }
  }
  const items = schema['items'];
  if (isPlainObject(items)) {
    validateResourceSchemaKeywords(id, `${path}.items`, items);
  } else if (Array.isArray(items)) {
    // tuple-form `items` (an array of per-position
    // schemas) is valid JSON Schema, but `core`'s validator only supports
    // the single-schema form applied to every element — a tuple silently
    // enforces nothing, invisibly rather than wrongly, so warn the same way
    // an unsupported keyword does.
    // eslint-disable-next-line no-console
    console.warn(
      `[agent-commerce] resource "${id}" ${path}.items is a tuple (an array of schemas), which this gateway does not enforce — only a single schema applied to every array element is supported (see src/core/execution/validation.ts). Each position's schema is unenforced; treat it as documentation only.`,
    );
  }
}

/**
 * `amount: z.string().min(1)` alone let "0,01", "$0.01", "1e-2", "-1" and an
 * over-precise "0.0000001" all pass config + `doctor`, then throw on every
 * purchase. A plain
 * positive decimal only — no currency symbol, no thousands separator, no
 * exponent notation.
 */
const PRICING_AMOUNT_PATTERN = /^\d+(?:\.\d+)?$/;
const ZERO_AMOUNT_PATTERN = /^0(?:\.0+)?$/;

function validatePricingAmount(id: string, amount: string, x402: NormalisedX402 | undefined): void {
  const path = `resources.${id}.pricing.amount`;
  if (!PRICING_AMOUNT_PATTERN.test(amount)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" has pricing.amount "${amount}", which is not a plain positive decimal (no currency symbol, no thousands separator, no exponent — e.g. "0.01")`,
      { details: { path, resourceId: id } },
    );
  }
  if (ZERO_AMOUNT_PATTERN.test(amount)) {
    // A zero-priced "paid" resource settles a zero-value transfer, which is
    // nonsense — if something is free, it should say so.
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" has pricing.amount "0" — a paid resource cannot cost zero; use "pricing: { type: free }" instead`,
      { details: { path, resourceId: id } },
    );
  }
  if (x402 !== undefined) {
    const fractionalDigits = amount.includes('.') ? (amount.split('.')[1]?.length ?? 0) : 0;
    if (fractionalDigits > x402.assetDecimals) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" has pricing.amount "${amount}" with more precision (${fractionalDigits} fractional digits) than the configured asset supports (${x402.assetDecimals} decimals)`,
        { details: { path, resourceId: id } },
      );
    }
  }
}

/**
 * The root-cause half. `validateBackendRequestShape`
 * (src/core) rejects a missing path parameter at request time — after
 * schema validation but, without this check, on every single call, because
 * a schema that never declares `{city}` can never satisfy it. A paid
 * resource in that shape settles the buyer's payment and then always fails
 * to reach the backend: no refund, replay key burned, on every call, not an
 * unlucky one. Every `{param}` in `backend.url` must be BOTH declared in
 * `properties` AND listed in `required` — an optional value hits the exact
 * same "caller structurally cannot supply it on every call that omits it"
 * problem as an undeclared one, just less often. This is the config-load
 * gate `agent-commerce validate`/`doctor` catch it at; the runtime
 * `INPUT_INVALID` in `validateBackendRequestShape` is defence in depth for
 * a hand-built `CommerceResource` this check never saw.
 */
function validatePathParametersDeclared(
  id: string,
  url: string,
  input: Record<string, unknown> | undefined,
): void {
  // Before anything else: a brace token the canonical grammar does not
  // recognise is neither extracted here nor substituted at request time, so it
  // would travel to the backend as a percent-encoded literal. On a paid
  // resource that is payment-without-delivery on every single call. Refuse it
  // at load rather than letting "matches nothing" mean "nothing to check".
  const stray = findUnparsedBraceToken(url);
  if (stray !== undefined) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" has backend.url containing "${stray}", which is not a valid path parameter (allowed characters: A-Z a-z 0-9 _ . -). It would be sent to the backend literally, so a paid resource would settle payment and then never reach the backend`,
      { details: { path: `resources.${id}.backend.url`, resourceId: id, token: stray } },
    );
  }

  const params = extractPathParameterNames(url);
  if (params.length === 0) return;

  const propertiesRaw = input?.['properties'];
  const properties = isPlainObject(propertiesRaw) ? propertiesRaw : {};
  const requiredRaw = input?.['required'];
  const required = new Set(
    Array.isArray(requiredRaw)
      ? requiredRaw.filter((entry): entry is string => typeof entry === 'string')
      : [],
  );

  for (const param of params) {
    const path = `resources.${id}.backend.url`;
    if (!Object.hasOwn(properties, param)) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" has backend.url path parameter "{${param}}" which is not declared in its input schema — the caller has no way to supply it, so every call would settle payment (if priced) and then fail to reach the backend`,
        { details: { path, resourceId: id, param } },
      );
    }
    if (!required.has(param)) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" has backend.url path parameter "{${param}}" declared in its input schema but not listed in "required" — a caller that omits it hits the same unservable-request problem as an undeclared parameter`,
        { details: { path, resourceId: id, param } },
      );
    }
  }
}

function validateBackendUrl(id: string, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" has an invalid backend.url "${url}": must be an absolute http:// or https:// URL`,
      { details: { path: `resources.${id}.backend.url`, resourceId: id } },
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" has a backend.url with scheme "${parsed.protocol}": must be http:// or https://`,
      { details: { path: `resources.${id}.backend.url`, resourceId: id } },
    );
  }
}

function validateAddress(path: string, value: string): void {
  if (!ADDRESS_PATTERN.test(value)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Configuration value at "${path}" is not a plausible address (expected "0x" followed by 40 hex characters)`,
      { details: { path } },
    );
  }
  if (ZERO_ADDRESS_PATTERN.test(value)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Configuration value at "${path}" must not be the zero address`,
      {
        details: { path },
      },
    );
  }
}
