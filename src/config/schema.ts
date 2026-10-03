/**
 * `config.yaml` schema, validation and normalization into the canonical
 * `GatewayConfig` (docs/contracts.md).
 *
 * 1. Zod validates shape: types, required fields, unknown keys. Numeric and
 *    boolean leaves accept their native type or a string, because env
 *    substitution produces strings. Zod transforms interact badly with
 *    `.strict()` inference, so coercion happens in plain TypeScript in step 2.
 * 2. A business-rule pass coerces those leaves and checks what needs a
 *    specific message: cross-references, disabled protocols and payment
 *    methods, dynamic pricing, addresses, duplicate trust entries.
 *
 * Env substitution (`${VAR}` / `${VAR:-default}`) runs over the raw value
 * before both steps, so numeric and boolean fields can be templated. The one
 * exception is `version:`, checked before substitution: it decides whether this
 * parser understands the document at all, so it cannot depend on the
 * environment.
 */

import { type ZodError, type ZodIssue, type ZodTypeAny, z } from 'zod';
import {
  AP2_DEFAULT_CLOCK_SKEW_SECONDS,
  AP2_JWK_COORDINATE_BYTES,
  AP2_JWK_CURVE,
  AP2_JWK_MEMBERS,
  AP2_KEY_TYPE,
  AP2_MAX_CLOCK_SKEW_SECONDS,
  AP2_MODES,
  AP2_SIGNING_ALGORITHM,
  AP2_SPEC_VERSION,
} from '../authorization/ap2/constants';
import type { Ap2AuthorizationConfig, Ap2Mode, Ap2TrustedIssuer } from '../authorization/ap2/types';
import {
  type AuthorizationMethodName,
  CommerceError,
  type CommerceResource,
  PAYMENT_METHOD_NAMES,
  PROTOCOL_NAMES,
  type Pricing,
  RESERVED_INPUT_FIELDS,
} from '../core';
import {
  extractPathParameterNames,
  findUnparsedBraceToken,
  isObjectSchemaNode,
} from '../core/execution';
import { isRecord } from '../core/is-record';
import {
  isMppNetwork,
  MPP_DEFAULT_NETWORK,
  MPP_MIN_CHALLENGE_SECRET_LENGTH,
  MPP_NETWORKS,
  MPP_PROFILE,
  type MppNetwork,
} from '../payments/mpp/constants';
import { resolveX402Deployment, type X402FacilitatorConfig } from '../payments/x402/guardrails';
import {
  ACP_CHECKOUT_OPERATIONS,
  ACP_OPERATION_INPUT_KEYS,
  ACP_OPERATION_OPTIONAL_INPUT_KEYS,
  ACP_SESSION_ID_INPUT_KEY,
  ACP_WELL_KNOWN_PATH,
  type AcpCheckoutOperation,
} from '../protocols/acp/constants';
import { MCP_TOOL_NAME_PATTERN } from '../protocols/mcp/constants';
import { substituteEnv } from './env';

const SUPPORTED_CONFIG_VERSION = 1;

// `0x` + 40 hex chars. Casing (the EIP-55 checksum) is not checked
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS_PATTERN = /^0x0{40}$/i;

// ---------------------------------------------------------------------------
// Zod schema for the shape of the raw (post-substitution) document
// ---------------------------------------------------------------------------

// A number, or a numeric string from env substitution
const NumberOrString = z.union([z.number(), z.string()]);
// A boolean, or a "true"/"false" string from env substitution
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
    // Shared secret gating /api/receipts and /api/events. Without it both
    // routes 404.
    adminToken: z.string().min(1).optional(),
    // Browser origins allowed to call the gateway; none by default. A request
    // with any other `Origin` gets 403 on every route. Entries match the
    // `Origin` header exactly (ignoring case), so `"*"` and a trailing slash
    // would match nothing: a silent lockout that an operator might "fix" by
    // disabling the check. Both are refused with a pointer.
    allowedOrigins: z
      .array(
        z
          .string()
          .min(1)
          .refine((origin) => origin !== '*', {
            message:
              'wildcard "*" is not supported - allowedOrigins entries are matched literally against the browser\'s Origin header, so "*" would match nothing. List each scheme://host[:port] explicitly.',
          })
          .refine((origin) => !origin.endsWith('/'), {
            message:
              'must not end with "/" - a browser Origin header never has a trailing slash, so this entry would match nothing. Use e.g. "http://localhost:5173".',
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

// Every path the gateway registers (`src/gateway/routes.ts`), plus the fixed
// discovery paths adapters own. A mount equal to one duplicates that route; a
// mount that is a prefix of one swallows it through its `${mountPath}/*` wildcard.
const RESERVED_GATEWAY_PATHS = [
  '/health',
  '/ready',
  '/.well-known/agent-commerce',
  // Fixed by the A2A specification and served by the adapter
  '/.well-known/agent-card.json',
  // Fixed by the ACP specification
  ACP_WELL_KNOWN_PATH,
  '/api/resources',
  '/api/resources/:id/invoke',
  '/api/receipts',
  '/api/events',
] as const;

// A bad `mountPath` would throw inside Fastify route registration at
// `server.ready()`, failing the whole gateway with an opaque `FST_ERR_*`.
// Checked here it is a CONFIG_INVALID naming the value. Pattern syntax (`:`,
// `*`) is refused because the mount registers its own wildcard.
const MountPathSchema = z
  .string()
  .min(1)
  .refine((value) => value.startsWith('/'), {
    message: 'must start with "/" - it is an absolute gateway path, e.g. "/mcp".',
  })
  .refine((value) => !/[:*?\s]/.test(value), {
    message:
      'must not contain ":", "*", "?" or whitespace - the mount is a literal path prefix, not a Fastify route pattern, and registers its own wildcard.',
  })
  .refine(
    (value) => {
      const base = value.replace(/\/+$/, '');
      return !RESERVED_GATEWAY_PATHS.some(
        (reserved) => reserved === base || reserved.startsWith(`${base}/`),
      );
    },
    {
      message: `must not collide with a route the gateway already serves (${RESERVED_GATEWAY_PATHS.join(', ')}); pick a dedicated prefix such as "/mcp".`,
    },
  );

// Bearer is the only ACP auth scheme; there is no `none`
const AcpAuthSchema = z.object({ type: z.literal('bearer'), token: z.string().min(1) }).strict();

const AcpIdempotencySchema = z
  .object({
    path: z.string().min(1),
    retentionHours: NumberOrString.optional(),
    merchantIdempotent: z.boolean().optional(),
  })
  .strict();

// Operation names are checked against `ACP_CHECKOUT_OPERATIONS` in the
// business pass, which names a missing or misspelled operation
const AcpCheckoutSchema = z.object({ operations: z.record(z.string().min(1)) }).strict();

// Optional discovery metadata, omitted when not configured
const AcpDiscoverySchema = z
  .object({
    documentationUrl: z.string().min(1).optional(),
    supportedCurrencies: z.array(z.string().min(1)).optional(),
    supportedLocales: z.array(z.string().min(1)).optional(),
    interventionTypes: z.array(z.string().min(1)).optional(),
  })
  .strict();

const ProtocolsSchema = z
  .object({
    http: z.object({ enabled: BooleanOrString }).strict(),
    mcp: z
      .object({
        enabled: BooleanOrString,
        mountPath: MountPathSchema,
      })
      .strict(),
    // Optional; A2A is off unless configured
    a2a: z
      .object({
        enabled: BooleanOrString,
        mountPath: MountPathSchema.optional(),
      })
      .strict()
      .optional(),
    // Optional and off by default. The business pass requires the sub-blocks
    // only when ACP is enabled, so a disabled placeholder stays valid and an
    // enabled block gets a message naming what it lacks.
    acp: z
      .object({
        enabled: BooleanOrString,
        mountPath: MountPathSchema.optional(),
        auth: AcpAuthSchema.optional(),
        idempotency: AcpIdempotencySchema.optional(),
        checkout: AcpCheckoutSchema.optional(),
        discovery: AcpDiscoverySchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// Applied when `protocols.a2a` is absent or names no mount
const DEFAULT_A2A_MOUNT_PATH = '/a2a';

// Applied when `protocols.acp` is absent or names no mount
const DEFAULT_ACP_MOUNT_PATH = '/acp';

// Idempotency records must outlive ACP's 24-hour retry window, or a replayed
// key could pass an expired record and run a checkout side effect twice. It is
// both the default and the floor.
const ACP_RETENTION_HOURS = 24;

const BackendMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

// Strict, so a typo like `bodyy` fails at load instead of silently meaning
// "no body binding"
const BackendInputBindingsSchema = z
  .object({
    path: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
    body: z.string().min(1).optional(),
  })
  .strict();

const BackendHandlerSchema = z
  .object({
    type: z.literal('http'),
    method: BackendMethodSchema,
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    timeoutMs: NumberOrString.optional(),
    inputBindings: BackendInputBindingsSchema.optional(),
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
    authorization: z
      .object({ required: z.array(z.string().min(1)).min(1) })
      .strict()
      .optional(),
  })
  .strict();

const ResourcesMapSchema = z.record(z.string().min(1), ResourceEntrySchema);

// Facilitator credentials. `none` and `bearer` fit any facilitator; `cdp` is
// the one vendor-specific type. Any other type is refused at load.
const FacilitatorAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('bearer'), token: z.string().min(1) }).strict(),
  // Coinbase Developer Platform. Needs the optional peer `@coinbase/x402`,
  // which signs a fresh JWT per request.
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
      // Absent auth sends no credential and normalizes to `{ type: 'none' }`,
      // which on mainnet requires `allowUnauthenticatedFacilitator`
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
    // Real funds. Never defaulted; see src/payments/x402/guardrails.ts
    allowMainnet: BooleanOrString.optional(),
    // Accepts credential-free facilitator access on mainnet. Never defaulted
    allowUnauthenticatedFacilitator: BooleanOrString.optional(),
  })
  .strict();

const MppSchema = z
  .object({
    enabled: BooleanOrString,
    network: z.string().min(1).optional(),
    rpcUrl: z.string().min(1),
    asset: z.string().min(1),
    assetName: z.string().min(1),
    assetVersion: z.string().min(1),
    recipient: z.string().min(1),
    realm: z.string().min(1),
    challengeSecret: z.string().min(1),
    challengeTtlSeconds: NumberOrString.optional(),
    facilitator: FacilitatorSchema,
    // Real funds. Never defaulted; see src/payments/x402/guardrails.ts
    allowMainnet: BooleanOrString.optional(),
    // Accepts credential-free facilitator access on mainnet. Never defaulted
    allowUnauthenticatedFacilitator: BooleanOrString.optional(),
  })
  .strict();

const PaymentsSchema = z
  .object({
    x402: X402Schema.optional(),
    mpp: MppSchema.optional(),
  })
  .strict();

// A public verification key, inline only: no `jwksUri`, `jku` or discovery
// URL. AP2 leaves secure key distribution open, and fetching keys would mean
// fetching from a location a mandate can influence. The business pass checks
// the JWK's members against `AP2_JWK_MEMBERS`, which also keeps out `x5u`.
const Ap2KeySchema = z
  .object({
    kid: z.string().min(1),
    jwk: z.record(z.string(), z.unknown()),
  })
  .strict();

const Ap2IssuerSchema = z
  .object({
    issuer: z.string().min(1),
    // Required, not defaulted: without it a mandate minted for another
    // merchant would verify here
    audience: z.string().min(1),
    keys: z.array(Ap2KeySchema).min(1),
  })
  .strict();

const Ap2Schema = z
  .object({
    enabled: BooleanOrString,
    specVersion: z.string().min(1).optional(),
    mode: z.string().min(1).optional(),
    trust: z
      .object({
        mandateIssuers: z.array(Ap2IssuerSchema).optional(),
        checkoutIssuers: z.array(Ap2IssuerSchema).optional(),
      })
      .strict()
      .optional(),
    clockSkewSeconds: NumberOrString.optional(),
    replay: z
      .object({ path: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

// Optional and off by default. The business pass requires the sub-blocks only
// when AP2 is enabled, and names the missing piece.
const AuthorizationSchema = z.object({ ap2: Ap2Schema.optional() }).strict();

const RawConfigSchema = z
  .object({
    version: z.literal(SUPPORTED_CONFIG_VERSION),
    merchant: MerchantSchema,
    server: ServerSchema,
    storage: StorageSchema,
    protocols: ProtocolsSchema,
    resources: ResourcesMapSchema,
    payments: PaymentsSchema,
    authorization: AuthorizationSchema.optional(),
  })
  .strict();

type RawConfig = z.infer<typeof RawConfigSchema>;
type RawResourceEntry = z.infer<typeof ResourceEntrySchema>;

// ---------------------------------------------------------------------------
// Public shape (docs/contracts.md)
// ---------------------------------------------------------------------------

/** Optional ACP discovery metadata. Absent fields are omitted from the document */
export interface AcpDiscoveryConfig {
  readonly documentationUrl?: string;
  readonly supportedCurrencies?: readonly string[];
  readonly supportedLocales?: readonly string[];
  readonly interventionTypes?: readonly string[];
}

/**
 * Discriminated on `enabled`, so an enabled ACP config carries everything the
 * adapter needs; a half-configured checkout is rejected at load
 */
export type AcpProtocolConfig =
  | { readonly enabled: false; readonly mountPath: string }
  | {
      readonly enabled: true;
      readonly mountPath: string;
      readonly auth: { readonly type: 'bearer'; readonly token: string };
      readonly idempotency: {
        readonly path: string;
        readonly retentionHours: number;
        readonly merchantIdempotent: boolean;
      };
      readonly checkout: {
        readonly operations: Readonly<Record<AcpCheckoutOperation, string>>;
      };
      readonly discovery?: AcpDiscoveryConfig;
    };

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
    readonly a2a: { readonly enabled: boolean; readonly mountPath: string };
    readonly acp: AcpProtocolConfig;
  };
  /** Canonical resources, already normalized */
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
    readonly mpp?: {
      readonly enabled: boolean;
      readonly network: MppNetwork;
      readonly rpcUrl: string;
      readonly asset: string;
      readonly assetName: string;
      readonly assetVersion: string;
      readonly recipient: string;
      readonly realm: string;
      readonly challengeSecret: string;
      readonly challengeTtlSeconds?: number;
      readonly facilitator: X402FacilitatorConfig;
      readonly allowMainnet?: boolean;
      readonly allowUnauthenticatedFacilitator?: boolean;
    };
  };
  /** Absent when no `authorization:` block is configured */
  readonly authorization?: { readonly ap2: Ap2AuthorizationConfig };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv): GatewayConfig {
  if (!isRecord(raw)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      'Configuration root must be a mapping (object) at "$"',
      {
        details: { path: '$' },
      },
    );
  }

  checkVersion(raw);

  const substituted = substituteEnv(raw, env);
  const parsed = parseWithZod(RawConfigSchema, substituted);
  return normalize(parsed);
}

function checkVersion(raw: Record<string, unknown>): void {
  if (!('version' in raw)) {
    throw new CommerceError('CONFIG_INVALID', 'Configuration is missing required field "version"', {
      details: { path: 'version' },
    });
  }
  const version = raw['version'];
  if (version !== SUPPORTED_CONFIG_VERSION) {
    const hint = typeof version === 'string' ? ', written as a number without quotes' : '';
    throw new CommerceError(
      'CONFIG_INVALID',
      `Unsupported config version "${String(version)}": this gateway only supports version ${SUPPORTED_CONFIG_VERSION}${hint}`,
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
// Numeric and boolean coercion (plain TypeScript, not Zod; see file header)
// ---------------------------------------------------------------------------

function toNumber(
  value: number | string,
  path: string,
  bounds: { min?: number; max?: number } = {},
): number {
  // Plain decimal digits only. `Number('')` is 0, which `server.port` accepts
  // ("let the OS pick"), so an empty `${PORT:-}` would bind a random port.
  // `Number` also accepts `"0x50"` and `"1e3"` for fields documented as decimal.
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
// Business rules and normalization into the canonical shape
// ---------------------------------------------------------------------------

const SUPPORTED_PROTOCOLS: ReadonlySet<string> = new Set(PROTOCOL_NAMES);
const SUPPORTED_PAYMENT_METHODS: ReadonlySet<string> = new Set(PAYMENT_METHOD_NAMES);
const SUPPORTED_AUTHORIZATION_METHODS: ReadonlySet<string> = new Set(['ap2']);

function normalize(raw: RawConfig): GatewayConfig {
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

  const x402Raw = raw.payments.x402;
  const x402 =
    x402Raw !== undefined
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
          facilitator: normalizeFacilitator(x402Raw.facilitator),
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
    // The provider makes the same call at construction; running it here lets
    // `agent-commerce validate` report an unsafe deployment before boot
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

  const mpp = normalizeMpp(raw.payments.mpp);

  const ap2 = normalizeAp2(raw.authorization?.ap2);
  if (ap2?.enabled) {
    validateReplayStoreIsolated(ap2.replay.path, raw.storage.receipts.path, protocols.acp);
  }

  const resources = Object.entries(raw.resources).map(([id, entry]) =>
    normalizeResource(id, entry, protocols, x402, mpp, ap2),
  );
  if (protocols.acp.enabled) validateAcpCheckoutMapping(protocols.acp, resources);

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
      ...(x402 !== undefined ? { x402 } : {}),
      ...(mpp !== undefined ? { mpp } : {}),
    },
    ...(ap2 !== undefined ? { authorization: { ap2 } } : {}),
  };
}

interface NormalizedProtocols {
  readonly http: { readonly enabled: boolean };
  readonly mcp: { readonly enabled: boolean; readonly mountPath: string };
  readonly a2a: { readonly enabled: boolean; readonly mountPath: string };
  readonly acp: AcpProtocolConfig;
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

// ---------------------------------------------------------------------------
// AP2 authorization (experimental)
// ---------------------------------------------------------------------------

type RawAp2 = NonNullable<NonNullable<RawConfig['authorization']>['ap2']>;

function ap2Invalid(
  path: string,
  message: string,
  extra: Record<string, unknown> = {},
): CommerceError {
  return new CommerceError('CONFIG_INVALID', message, { details: { path, ...extra } });
}

function normalizeAp2(raw: RawAp2 | undefined): Ap2AuthorizationConfig | undefined {
  if (raw === undefined) return undefined;
  if (!toBoolean(raw.enabled, 'authorization.ap2.enabled')) return { enabled: false };

  const specVersion = raw.specVersion ?? AP2_SPEC_VERSION;
  if (specVersion !== AP2_SPEC_VERSION) {
    throw ap2Invalid(
      'authorization.ap2.specVersion',
      `authorization.ap2.specVersion "${specVersion}" is not supported - this gateway verifies against the tagged AP2 release ${AP2_SPEC_VERSION} only`,
    );
  }

  const mode = raw.mode ?? AP2_MODES[0];
  if (!(AP2_MODES as readonly string[]).includes(mode)) {
    throw ap2Invalid(
      'authorization.ap2.mode',
      `authorization.ap2.mode "${mode}" is not supported. Supported: ${AP2_MODES.join(', ')}. Autonomous mode needs open mandates, agent key binding and constraint evaluation, none of which this release implements.`,
    );
  }

  if (raw.replay === undefined) {
    throw ap2Invalid(
      'authorization.ap2.replay',
      'authorization.ap2.replay is required when AP2 is enabled - it names the SQLite file recording which mandates have been spent, and without it a verified mandate could authorize a second settlement',
    );
  }

  const mandateIssuers = normalizeIssuers(
    raw.trust?.mandateIssuers,
    'authorization.ap2.trust.mandateIssuers',
  );
  const checkoutIssuers = normalizeIssuers(
    raw.trust?.checkoutIssuers,
    'authorization.ap2.trust.checkoutIssuers',
  );

  return {
    enabled: true,
    specVersion: AP2_SPEC_VERSION,
    mode: mode as Ap2Mode,
    trust: { mandateIssuers, checkoutIssuers },
    clockSkewSeconds: toNumber(
      raw.clockSkewSeconds ?? AP2_DEFAULT_CLOCK_SKEW_SECONDS,
      'authorization.ap2.clockSkewSeconds',
      { min: 0, max: AP2_MAX_CLOCK_SKEW_SECONDS },
    ),
    replay: { path: raw.replay.path },
  };
}

// Both issuer lists must be non-empty when AP2 is on: verification checks the
// issuer's signature over the Checkout Mandate and the merchant's over the
// checkout JWT it binds. An empty list would fail every mandate at request
// time instead of at load.
function normalizeIssuers(
  raw: readonly z.infer<typeof Ap2IssuerSchema>[] | undefined,
  path: string,
): readonly Ap2TrustedIssuer[] {
  if (raw === undefined || raw.length === 0) {
    throw ap2Invalid(
      path,
      `${path} is required when AP2 is enabled and must name at least one issuer - trust is operator-configured and static, so an empty list means no mandate can ever verify`,
    );
  }

  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const entryPath = `${path}.${index}`;
    if (seen.has(entry.issuer)) {
      throw ap2Invalid(
        `${entryPath}.issuer`,
        `${entryPath}.issuer "${entry.issuer}" is listed twice - key lookup resolves by issuer, so a second entry for the same one is silently unreachable. Merge the keys into one entry instead (which is also how a rotation overlaps an old and a new key).`,
        { issuer: entry.issuer },
      );
    }
    seen.add(entry.issuer);

    const kids = new Set<string>();
    const keys = entry.keys.map((key, keyIndex) => {
      const keyPath = `${entryPath}.keys.${keyIndex}`;
      if (kids.has(key.kid)) {
        throw ap2Invalid(
          `${keyPath}.kid`,
          `${keyPath}.kid "${key.kid}" is listed twice for issuer "${entry.issuer}" - a kid selects exactly one key, so which of the two verifies a signature would be undefined`,
          { issuer: entry.issuer, kid: key.kid },
        );
      }
      kids.add(key.kid);
      return { kid: key.kid, jwk: validateJwk(key.jwk, key.kid, keyPath) };
    });

    return { issuer: entry.issuer, audience: entry.audience, keys };
  });
}

// Accepts only a public P-256 key. Every member is checked at load rather than
// by the JOSE library at the first purchase, so a bad key fails the deploy
// instead of a buyer's valid mandate.
function validateJwk(
  jwk: Record<string, unknown>,
  kid: string,
  path: string,
): Readonly<Record<string, string>> {
  const fail = (detail: string): never => {
    throw ap2Invalid(`${path}.jwk`, `${path}.jwk (kid "${kid}") ${detail}`, { kid });
  };

  for (const member of Object.keys(jwk)) {
    if ((AP2_JWK_MEMBERS as readonly string[]).includes(member)) continue;
    // `d` (an EC private scalar) or `k` (a symmetric key) means signing
    // material was pasted where only verification material belongs, which the
    // operator needs to hear about specifically
    if (member === 'd' || member === 'k') {
      fail(
        `carries private key material ("${member}"). The gateway verifies signatures and never produces them; publish only the public half. Treat the pasted key as compromised and rotate it.`,
      );
    }
    fail(
      `has unsupported member "${member}". Allowed: ${AP2_JWK_MEMBERS.join(', ')}. Members naming a URL are refused on purpose - keys are configured inline and never fetched.`,
    );
  }

  const value = (member: string): string => {
    const raw = jwk[member];
    if (typeof raw !== 'string' || raw.length === 0) {
      fail(`must give "${member}" as a non-empty string`);
    }
    return raw as string;
  };

  if (value('kty') !== AP2_KEY_TYPE) {
    fail(
      `must have kty "${AP2_KEY_TYPE}" (got "${value('kty')}") - ${AP2_SIGNING_ALGORITHM} is the only accepted algorithm`,
    );
  }
  if (value('crv') !== AP2_JWK_CURVE) {
    fail(
      `must be on curve "${AP2_JWK_CURVE}" (got "${value('crv')}") - ${AP2_SIGNING_ALGORITHM} is the only accepted algorithm`,
    );
  }
  for (const coordinate of ['x', 'y'] as const) {
    const encoded = value(coordinate);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
      fail(`coordinate "${coordinate}" is not base64url (no padding, no "+" or "/")`);
    }
    if (Buffer.from(encoded, 'base64url').length !== AP2_JWK_COORDINATE_BYTES) {
      fail(
        `coordinate "${coordinate}" decodes to ${Buffer.from(encoded, 'base64url').length} bytes; a ${AP2_JWK_CURVE} coordinate is ${AP2_JWK_COORDINATE_BYTES}`,
      );
    }
  }
  if (jwk['alg'] !== undefined && value('alg') !== AP2_SIGNING_ALGORITHM) {
    fail(`declares alg "${value('alg')}"; only ${AP2_SIGNING_ALGORITHM} is accepted`);
  }
  if (jwk['use'] !== undefined && value('use') !== 'sig') {
    fail(`declares use "${value('use')}"; a verification key must be "sig"`);
  }
  if (jwk['kid'] !== undefined && value('kid') !== kid) {
    fail(`declares kid "${value('kid')}", which disagrees with the configured kid "${kid}"`);
  }

  const normalized: Record<string, string> = {};
  for (const member of AP2_JWK_MEMBERS) {
    if (jwk[member] !== undefined) normalized[member] = value(member);
  }
  return normalized;
}

// The AP2 replay store gets its own SQLite file. Reserved mandates, payment
// attempts and ACP idempotency records have different schemas and retention
// rules, and a shared file means a migration conflict at startup or a shared
// write lock on the settlement path.
function validateReplayStoreIsolated(
  replayPath: string,
  receiptsPath: string,
  acp: AcpProtocolConfig,
): void {
  // Every `:memory:` handle is its own private database, so equal strings do
  // not collide
  if (replayPath === ':memory:') return;

  const others: [string, string][] = [['storage.receipts.path', receiptsPath]];
  if (acp.enabled) others.push(['protocols.acp.idempotency.path', acp.idempotency.path]);

  for (const [otherPath, other] of others) {
    if (replayPath !== other) continue;
    throw ap2Invalid(
      'authorization.ap2.replay.path',
      `authorization.ap2.replay.path is the same file as ${otherPath} ("${replayPath}") - the AP2 replay store keeps its own schema and must not share a database with another store`,
    );
  }
}

// Resolves a resource's `authorization.required` list against the configured
// provider. A requirement that cannot be enforced is refused: the resource
// would look protected in config and settle unprotected.
function normalizeResourceAuthorization(
  id: string,
  entry: RawResourceEntry,
  pricing: Pricing,
  ap2: Ap2AuthorizationConfig | undefined,
): CommerceResource['authorization'] | undefined {
  const required = entry.authorization?.required;
  if (required === undefined) return undefined;

  const path = `resources.${id}.authorization.required`;
  const methods: AuthorizationMethodName[] = [];
  for (const method of required) {
    if (!SUPPORTED_AUTHORIZATION_METHODS.has(method)) {
      throw ap2Invalid(
        path,
        `Resource "${id}" requires unsupported authorization method "${method}". Supported: ${[...SUPPORTED_AUTHORIZATION_METHODS].join(', ')}.`,
        { resourceId: id, method },
      );
    }
    if (methods.includes(method as AuthorizationMethodName)) {
      throw ap2Invalid(path, `Resource "${id}" lists authorization method "${method}" twice`, {
        resourceId: id,
        method,
      });
    }
    if (method === 'ap2' && (ap2 === undefined || !ap2.enabled)) {
      throw ap2Invalid(
        path,
        `Resource "${id}" requires authorization method "ap2", which is not configured or not enabled under authorization.ap2`,
        { resourceId: id, method },
      );
    }
    methods.push(method as AuthorizationMethodName);
  }

  // A mandate binds an exact amount and currency and never unlocks a resource
  // by itself, so it only means something on a fixed-price resource
  if (pricing.type !== 'fixed') {
    throw ap2Invalid(
      path,
      `Resource "${id}" requires authorization but its pricing is "${pricing.type}" - authorization proves a purchase was approved and never replaces payment, so it applies to fixed-price paid resources only in this release`,
      { resourceId: id },
    );
  }

  return { required: methods };
}

// ---------------------------------------------------------------------------
// ACP (experimental)
// ---------------------------------------------------------------------------

type RawAcp = NonNullable<RawConfig['protocols']['acp']>;
type EnabledAcpConfig = Extract<AcpProtocolConfig, { enabled: true }>;

function acpInvalid(
  path: string,
  message: string,
  extra: Record<string, unknown> = {},
): CommerceError {
  return new CommerceError('CONFIG_INVALID', message, { details: { path, ...extra } });
}

function normalizeAcp(raw: RawAcp | undefined): AcpProtocolConfig {
  const mountPath = raw?.mountPath ?? DEFAULT_ACP_MOUNT_PATH;
  if (raw === undefined || !toBoolean(raw.enabled, 'protocols.acp.enabled')) {
    return { enabled: false, mountPath };
  }

  if (raw.auth === undefined) {
    throw acpInvalid(
      'protocols.acp.auth',
      'protocols.acp.auth is required when ACP is enabled - every ACP checkout endpoint is authenticated, and "bearer" is the only scheme supported in this release',
    );
  }
  if (raw.idempotency === undefined) {
    throw acpInvalid(
      'protocols.acp.idempotency',
      'protocols.acp.idempotency is required when ACP is enabled - it names the SQLite file holding checkout idempotency records, and ACP makes the Idempotency-Key mandatory on every checkout POST',
    );
  }

  const discovery = raw.discovery;

  return {
    enabled: true,
    mountPath,
    auth: raw.auth,
    idempotency: {
      path: raw.idempotency.path,
      retentionHours: toNumber(
        raw.idempotency.retentionHours ?? ACP_RETENTION_HOURS,
        'protocols.acp.idempotency.retentionHours',
        { min: ACP_RETENTION_HOURS },
      ),
      merchantIdempotent: raw.idempotency.merchantIdempotent ?? false,
    },
    checkout: { operations: normalizeAcpOperations(raw.checkout) },
    // Built key by key so absent metadata stays absent rather than `undefined`
    ...(discovery !== undefined
      ? {
          discovery: {
            ...(discovery.documentationUrl !== undefined
              ? { documentationUrl: discovery.documentationUrl }
              : {}),
            ...(discovery.supportedCurrencies !== undefined
              ? { supportedCurrencies: discovery.supportedCurrencies }
              : {}),
            ...(discovery.supportedLocales !== undefined
              ? { supportedLocales: discovery.supportedLocales }
              : {}),
            ...(discovery.interventionTypes !== undefined
              ? { interventionTypes: discovery.interventionTypes }
              : {}),
          },
        }
      : {}),
  };
}

// All five operations, each on its own resource. ACP discovery advertises
// `checkout` as one service, so a partial mapping is refused. Operations differ
// in method, input and success status, so one resource cannot serve two.
function normalizeAcpOperations(
  checkout: RawAcp['checkout'],
): Readonly<Record<AcpCheckoutOperation, string>> {
  const configured: Record<string, string> = checkout?.operations ?? {};

  for (const key of Object.keys(configured)) {
    if (!(ACP_CHECKOUT_OPERATIONS as readonly string[]).includes(key)) {
      throw acpInvalid(
        `protocols.acp.checkout.operations.${key}`,
        `protocols.acp.checkout.operations names unknown ACP checkout operation "${key}". Supported: ${ACP_CHECKOUT_OPERATIONS.join(', ')}.`,
      );
    }
  }

  const operations: Record<string, string> = {};
  const claimedBy = new Map<string, AcpCheckoutOperation>();
  for (const operation of ACP_CHECKOUT_OPERATIONS) {
    const path = `protocols.acp.checkout.operations.${operation}`;
    const resourceId = configured[operation];
    if (resourceId === undefined) {
      throw acpInvalid(
        path,
        `${path} is required when ACP is enabled - all five checkout operations must be mapped, since ACP discovery advertises the checkout service as a whole`,
      );
    }
    const claimed = claimedBy.get(resourceId);
    if (claimed !== undefined) {
      throw acpInvalid(
        path,
        `${path} maps resource "${resourceId}", which is already mapped to "${claimed}" - each ACP checkout operation needs its own resource`,
        { resourceId },
      );
    }
    claimedBy.set(resourceId, operation);
    operations[operation] = resourceId;
  }
  return operations as Record<AcpCheckoutOperation, string>;
}

function validateAcpCheckoutMapping(
  acp: EnabledAcpConfig,
  resources: readonly CommerceResource[],
): void {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));

  for (const operation of ACP_CHECKOUT_OPERATIONS) {
    const resourceId = acp.checkout.operations[operation];
    const path = `protocols.acp.checkout.operations.${operation}`;
    const resource = byId.get(resourceId);
    if (resource === undefined) {
      throw acpInvalid(
        path,
        `${path} maps resource "${resourceId}", which is not defined under "resources"`,
        { resourceId },
      );
    }
    if (!resource.exposedVia.includes('acp')) {
      throw acpInvalid(
        path,
        `Resource "${resourceId}" implements ACP operation "${operation}" but does not list "acp" in its expose - the mapping says which resource serves the operation, expose says ACP may invoke it, and both are required`,
        { resourceId },
      );
    }
    // ACP checkout carries the merchant's own purchase payment (`payment_data`
    // on completion), and ACP has no wire form for our payment-required
    // outcome, so the invocation itself must be free
    if (resource.pricing.type !== 'free' || resource.paymentMethods.length > 0) {
      throw acpInvalid(
        path,
        `Resource "${resourceId}" implements ACP operation "${operation}" and must use pricing.type "free" with no "payments" - ACP checkout carries the merchant's own purchase payment, so the gateway does not also charge for the invocation`,
        { resourceId },
      );
    }
    validateAcpOperationInput(path, operation, resource);
  }
}

// A schema that forbids a key the adapter sends, or requires one it may not
// send, fails requests with INPUT_INVALID. Refused at load instead. An optional
// key counts as sent: a closed cancel schema without `body` would pass a bare
// cancel and refuse every one that carries `intent_trace`. Normalization has
// already closed every object node that omits additionalProperties, so the
// check also looks inside `path` and `body`: a bare `body: { type: object }`
// arrives here accepting no key at all.
function validateAcpOperationInput(
  path: string,
  operation: AcpCheckoutOperation,
  resource: CommerceResource,
): void {
  const schema = resource.inputSchema;
  if (schema === undefined) return;
  const keys: readonly string[] = ACP_OPERATION_INPUT_KEYS[operation];
  const optionalKeys: readonly string[] = ACP_OPERATION_OPTIONAL_INPUT_KEYS[operation] ?? [];
  const sent = [...keys, ...optionalKeys];

  const topLevel = closedObjectProperties(schema);
  if (topLevel !== undefined) {
    for (const key of sent) {
      if (!Object.hasOwn(topLevel, key)) {
        const when = keys.includes(key) ? 'always sends' : 'sends when the caller supplies it';
        throw acpInvalid(
          path,
          `Resource "${resource.id}" implements ACP operation "${operation}" but its input schema sets additionalProperties: false without declaring "${key}", which the adapter ${when} for this operation`,
          { resourceId: resource.id },
        );
      }
    }
  }

  const declared = isRecord(schema['properties']) ? schema['properties'] : {};
  const pathKeys = closedObjectProperties(declared['path']);
  if (
    sent.includes('path') &&
    pathKeys !== undefined &&
    !Object.hasOwn(pathKeys, ACP_SESSION_ID_INPUT_KEY)
  ) {
    throw acpInvalid(
      path,
      `Resource "${resource.id}" implements ACP operation "${operation}" but its "path" schema sets additionalProperties: false without declaring "${ACP_SESSION_ID_INPUT_KEY}", which the adapter always sends inside "path"`,
      { resourceId: resource.id },
    );
  }
  const bodyKeys = closedObjectProperties(declared['body']);
  if (sent.includes('body') && bodyKeys !== undefined && Object.keys(bodyKeys).length === 0) {
    throw acpInvalid(
      path,
      `Resource "${resource.id}" implements ACP operation "${operation}" but its "body" schema accepts no keys, so it refuses every ACP document. Config load closes an object schema that omits additionalProperties: declare body as { type: object, additionalProperties: true }`,
      { resourceId: resource.id },
    );
  }

  const required = schema['required'];
  if (Array.isArray(required)) {
    for (const entry of required) {
      if (typeof entry === 'string' && !keys.includes(entry)) {
        throw acpInvalid(
          path,
          `Resource "${resource.id}" implements ACP operation "${operation}" but its input schema requires "${entry}", which that operation does not always supply (it always sends: ${keys.join(', ')})`,
          { resourceId: resource.id },
        );
      }
    }
  }
}

// The declared properties of a closed object schema, or undefined when the
// schema accepts keys it does not declare
function closedObjectProperties(schema: unknown): Record<string, unknown> | undefined {
  if (!isRecord(schema) || schema['additionalProperties'] !== false) return undefined;
  return isRecord(schema['properties']) ? schema['properties'] : {};
}

interface NormalizedX402 {
  readonly enabled: boolean;
  readonly assetDecimals: number;
}

function normalizeFacilitator(raw: z.infer<typeof FacilitatorSchema>): X402FacilitatorConfig {
  return raw.mode === 'local'
    ? { mode: 'local', signerPrivateKey: raw.signerPrivateKey }
    : { mode: 'remote', url: raw.url, auth: raw.auth ?? { type: 'none' } };
}

type NormalizedMpp = NonNullable<GatewayConfig['payments']['mpp']>;

function normalizeMpp(raw: RawConfig['payments']['mpp']): NormalizedMpp | undefined {
  if (raw === undefined) return undefined;
  const network = raw.network ?? MPP_DEFAULT_NETWORK;
  if (!isMppNetwork(network)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `payments.mpp.network must be one of ${MPP_NETWORKS.join(', ')}`,
      { details: { path: 'payments.mpp.network' } },
    );
  }
  const mpp: NormalizedMpp = {
    enabled: toBoolean(raw.enabled, 'payments.mpp.enabled'),
    network,
    rpcUrl: raw.rpcUrl,
    asset: raw.asset,
    assetName: raw.assetName,
    assetVersion: raw.assetVersion,
    recipient: raw.recipient,
    realm: raw.realm,
    challengeSecret: raw.challengeSecret,
    ...(raw.challengeTtlSeconds !== undefined
      ? {
          challengeTtlSeconds: toNumber(
            raw.challengeTtlSeconds,
            'payments.mpp.challengeTtlSeconds',
            { min: 1 },
          ),
        }
      : {}),
    facilitator: normalizeFacilitator(raw.facilitator),
    ...(raw.allowMainnet !== undefined
      ? { allowMainnet: toBoolean(raw.allowMainnet, 'payments.mpp.allowMainnet') }
      : {}),
    ...(raw.allowUnauthenticatedFacilitator !== undefined
      ? {
          allowUnauthenticatedFacilitator: toBoolean(
            raw.allowUnauthenticatedFacilitator,
            'payments.mpp.allowUnauthenticatedFacilitator',
          ),
        }
      : {}),
  };
  validateAddress('payments.mpp.recipient', mpp.recipient);
  validateAddress('payments.mpp.asset', mpp.asset);
  // mppx refuses CR or LF in a quoted challenge parameter
  if (/[\r\n]/.test(mpp.realm)) {
    throw new CommerceError('CONFIG_INVALID', 'payments.mpp.realm must be a single line', {
      details: { path: 'payments.mpp.realm' },
    });
  }
  // Length only: the secret itself never appears in an error
  if (mpp.challengeSecret.length < MPP_MIN_CHALLENGE_SECRET_LENGTH) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `payments.mpp.challengeSecret must have length at least ${MPP_MIN_CHALLENGE_SECRET_LENGTH}`,
      { details: { path: 'payments.mpp.challengeSecret' } },
    );
  }
  // The shared x402 address, facilitator and mainnet guards, reported under the
  // MPP config path
  resolveX402Deployment({
    network: mpp.network,
    payTo: mpp.recipient,
    asset: mpp.asset,
    assetName: mpp.assetName,
    assetVersion: mpp.assetVersion,
    facilitator: mpp.facilitator,
    ...(mpp.allowMainnet !== undefined ? { allowMainnet: mpp.allowMainnet } : {}),
    ...(mpp.allowUnauthenticatedFacilitator !== undefined
      ? { allowUnauthenticatedFacilitator: mpp.allowUnauthenticatedFacilitator }
      : {}),
    configPath: 'payments.mpp',
    payToField: 'recipient',
  });
  return mpp;
}

function normalizeResource(
  id: string,
  entry: RawResourceEntry,
  protocols: NormalizedProtocols,
  x402: NormalizedX402 | undefined,
  mpp: NormalizedMpp | undefined,
  ap2: Ap2AuthorizationConfig | undefined,
): CommerceResource {
  if (entry.input !== undefined) validateResourceSchemaKeywords(id, 'input', entry.input);

  const inputProperties = entry.input?.['properties'];
  if (inputProperties && typeof inputProperties === 'object') {
    for (const reserved of RESERVED_INPUT_FIELDS) {
      if (!(reserved in inputProperties)) continue;
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" declares an input property "${reserved}", which is reserved by the gateway`,
        {
          details: {
            path: `resources.${id}.input.properties.${reserved}`,
            resourceId: id,
          },
        },
      );
    }
  }

  for (const protocol of entry.expose) {
    if (!SUPPORTED_PROTOCOLS.has(protocol)) {
      const hint = protocol === 'ucp' ? ' (UCP is planned, not supported in this release)' : '';
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" exposes unsupported protocol "${protocol}"${hint}. Supported: ${PROTOCOL_NAMES.join(', ')}.`,
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
  if (entry.expose.includes('a2a') && !protocols.a2a.enabled) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" is exposed via "a2a" but protocols.a2a.enabled is false`,
      { details: { path: `resources.${id}.expose`, resourceId: id } },
    );
  }
  if (entry.expose.includes('acp') && !protocols.acp.enabled) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" is exposed via "acp" but protocols.acp.enabled is false`,
      { details: { path: `resources.${id}.expose`, resourceId: id } },
    );
  }
  if (entry.expose.includes('http') && !protocols.http.enabled) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" is exposed via "http" but protocols.http.enabled is false`,
      { details: { path: `resources.${id}.expose`, resourceId: id } },
    );
  }

  validateBackendUrl(id, entry.backend.url);
  validateBackendHeaders(id, entry.backend.headers);
  const pathScope = validateInputBindings(id, entry.backend, entry.input);
  validatePathParametersDeclared(id, entry.backend.url, pathScope.schema, pathScope.where);

  if (entry.pricing.type === 'dynamic') {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" uses pricing.type "dynamic", which is not supported in this release`,
      { details: { path: `resources.${id}.pricing.type`, resourceId: id } },
    );
  }

  if (entry.pricing.type === 'fixed') {
    validatePricingAmount(id, entry.pricing.amount, x402?.assetDecimals);
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
          `Resource "${id}" names unsupported payment method "${method}". Supported: ${PAYMENT_METHOD_NAMES.join(', ')}.`,
          { details: { path: `resources.${id}.payments`, resourceId: id, method } },
        );
      }
    }
    // At least one named rail must be enabled, not every one. `main.ts` checks
    // again at composition as defense in depth.
    const enabledRails = [...(x402?.enabled ? ['x402'] : []), ...(mpp?.enabled ? ['mpp'] : [])];
    if (!paymentMethods.some((method) => enabledRails.includes(method))) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" names payment method(s) "${paymentMethods.join(', ')}", none of which is configured and enabled under "payments"`,
        { details: { path: `resources.${id}.payments`, resourceId: id, paymentMethods } },
      );
    }
    // MPP fixes the currency label and decimal precision for every resource it serves
    if (mpp?.enabled && paymentMethods.includes('mpp')) {
      if (entry.pricing.currency !== MPP_PROFILE.assetSymbol) {
        throw new CommerceError(
          'CONFIG_INVALID',
          `Resource "${id}" is priced in ${entry.pricing.currency}, but MPP charges ${MPP_PROFILE.assetSymbol}`,
          { details: { path: `resources.${id}.pricing.currency`, resourceId: id } },
        );
      }
      validatePricingAmount(id, entry.pricing.amount, MPP_PROFILE.assetDecimals);
    }
  }

  const pricing: Pricing =
    entry.pricing.type === 'free'
      ? { type: 'free' }
      : { type: 'fixed', amount: entry.pricing.amount, currency: entry.pricing.currency };

  const authorization = normalizeResourceAuthorization(id, entry, pricing, ap2);

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
      ...(entry.backend.inputBindings !== undefined
        ? { inputBindings: pickDefined(entry.backend.inputBindings) }
        : {}),
    },
    pricing,
    exposedVia: entry.expose as CommerceResource['exposedVia'],
    paymentMethods: paymentMethods as CommerceResource['paymentMethods'],
    ...(authorization !== undefined ? { authorization } : {}),
  };
}

/**
 * Closes every object schema at every depth: a node without
 * `additionalProperties` gets `false`, so unknown keys never reach the
 * merchant's API. An explicit value, including `true`, is kept.
 *
 * JSON Schema itself defaults to open, and core's validator enforces
 * `additionalProperties` only where a node states it, so this recurses into
 * `properties`, `items` and schema-valued `additionalProperties`, the same
 * places the validator descends. Object-ness comes from `isObjectSchemaNode`,
 * the validator's own definition.
 */
function defaultClosedObjectSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const isObjectSchema = isObjectSchemaNode(schema);
  const result: Record<string, unknown> = { ...schema };

  if (isObjectSchema) {
    const properties = schema['properties'];
    if (isRecord(properties)) {
      result['properties'] = Object.fromEntries(
        Object.entries(properties).map(([key, sub]) => [
          key,
          isRecord(sub) ? defaultClosedObjectSchema(sub) : sub,
        ]),
      );
    }
    if (!Object.hasOwn(schema, 'additionalProperties')) {
      result['additionalProperties'] = false;
    }
  }

  const items = schema['items'];
  if (isRecord(items)) {
    result['items'] = defaultClosedObjectSchema(items);
  }

  // `additionalProperties: {schema}` (a map of typed objects) is closed too.
  // Not conditional on `isObjectSchema`: the validator applies the subschema
  // wherever it finds one.
  const additional = schema['additionalProperties'];
  if (isRecord(additional)) {
    result['additionalProperties'] = defaultClosedObjectSchema(additional);
  }

  return result;
}

// The input schema of a resource that declares no `input:`. Declaring nothing
// accepts nothing: without this, `compileJsonSchema(undefined)` would accept
// any input and forward every key to the backend. A no-argument resource
// omitting `input:` is a legitimate shape, so it is not refused.
const EMPTY_CLOSED_OBJECT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

// Keywords core's validator ignores (see `execution/validation.ts` for the
// enforced subset). Config warns at load, since an operator who writes
// `pattern` cannot otherwise tell that it is not enforced.
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

// `type` set to something that rules out "object". No `type` at all does not
// exclude it: the validator treats `properties`/`required` alone as an object
// schema.
function excludesObjectType(schema: Record<string, unknown>): boolean {
  const type = schema['type'];
  if (type === undefined || type === 'object') return false;
  if (Array.isArray(type)) return !type.includes('object');
  return true;
}

/**
 * Walks a resource's input schema once. Warns about unenforced keywords and
 * tuple `items`. Rejects a node whose `type` rules out "object" while it
 * declares `properties` or `required`, which then go unchecked (often a
 * copy-pasted sibling whose `type` was never updated), and a closed node
 * requiring a property it never declares, which no input can satisfy.
 */
function validateResourceSchemaKeywords(
  id: string,
  path: string,
  schema: Record<string, unknown>,
): void {
  for (const keyword of UNSUPPORTED_SCHEMA_KEYWORDS) {
    if (Object.hasOwn(schema, keyword)) {
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
      `Resource "${id}" ${path} declares "properties" and/or "required" but its "type" (${JSON.stringify(schema['type'])}) does not include "object" - the validator will never route a value through either check under that type, so this schema claims to constrain input it does not actually enforce. Remove "properties"/"required", or include "object" in "type".`,
      { details: { path: `resources.${id}.${path}`, resourceId: id } },
    );
  }
  // A closed node that requires a property it never declares rejects that
  // property as unknown, so no input can satisfy it and every call would 400.
  // Only when the node is closed: an explicit `additionalProperties`
  // other than `false` leaves the name reachable.
  const requiredRaw = schema['required'];
  const closed = !Object.hasOwn(schema, 'additionalProperties')
    ? true
    : schema['additionalProperties'] === false;
  if (Array.isArray(requiredRaw) && closed && isObjectSchemaNode(schema)) {
    const declared = isRecord(schema['properties']) ? schema['properties'] : {};
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
  if (isRecord(properties)) {
    for (const [key, sub] of Object.entries(properties)) {
      if (isRecord(sub)) validateResourceSchemaKeywords(id, `${path}.properties.${key}`, sub);
    }
  }
  const additional = schema['additionalProperties'];
  if (isRecord(additional)) {
    validateResourceSchemaKeywords(id, `${path}.additionalProperties`, additional);
  }
  const items = schema['items'];
  if (isRecord(items)) {
    validateResourceSchemaKeywords(id, `${path}.items`, items);
  } else if (Array.isArray(items)) {
    // Tuple-form `items` is valid JSON Schema, but the validator supports only
    // one schema for every element, so a tuple enforces nothing
    console.warn(
      `[agent-commerce] resource "${id}" ${path}.items is a tuple (an array of schemas), which this gateway does not enforce - only a single schema applied to every array element is supported (see src/core/execution/validation.ts). Each position's schema is unenforced; treat it as documentation only.`,
    );
  }
}

// A plain decimal: no currency symbol, thousands separator, sign or exponent.
// "0,01", "$0.01", "1e-2" and "-1" would otherwise load and then fail every
// purchase.
const PRICING_AMOUNT_PATTERN = /^\d+(?:\.\d+)?$/;
const ZERO_AMOUNT_PATTERN = /^0(?:\.0+)?$/;

function validatePricingAmount(id: string, amount: string, decimals: number | undefined): void {
  const path = `resources.${id}.pricing.amount`;
  if (!PRICING_AMOUNT_PATTERN.test(amount)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" has pricing.amount "${amount}", which is not a plain positive decimal (no currency symbol, no thousands separator, no exponent - e.g. "0.01")`,
      { details: { path, resourceId: id } },
    );
  }
  if (ZERO_AMOUNT_PATTERN.test(amount)) {
    // A zero-priced paid resource would settle a zero-value transfer
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" has pricing.amount "0" - a paid resource cannot cost zero; use "pricing: { type: free }" instead`,
      { details: { path, resourceId: id } },
    );
  }
  if (decimals !== undefined) {
    const fractionalDigits = amount.includes('.') ? (amount.split('.')[1]?.length ?? 0) : 0;
    if (fractionalDigits > decimals) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" has pricing.amount "${amount}" with more precision (${fractionalDigits} fractional digits) than the configured asset supports (${decimals} decimals)`,
        { details: { path, resourceId: id } },
      );
    }
  }
}

/**
 * Checks `backend.inputBindings` against the input schema at load. Schemas are
 * closed by default at every depth, so a binding naming an undeclared property
 * could never be supplied, and on a paid resource the backend would get an
 * incomplete request after payment.
 *
 * Returns the schema node `{param}` names must be declared in: the path group
 * with bindings, the whole input without.
 */
function validateInputBindings(
  id: string,
  backend: RawResourceEntry['backend'],
  input: Record<string, unknown> | undefined,
): { readonly schema: Record<string, unknown> | undefined; readonly where: string } {
  const legacy = { schema: input, where: 'its input schema' } as const;
  const bindings = backend.inputBindings;
  const templated = extractPathParameterNames(backend.url).length > 0;
  if (bindings === undefined) return legacy;

  const path = `resources.${id}.backend.inputBindings`;
  const fail = (message: string, details: Record<string, unknown> = {}): never => {
    throw new CommerceError('CONFIG_INVALID', `Resource "${id}" ${message}`, {
      details: { path, resourceId: id, ...details },
    });
  };

  const entries = Object.entries(bindings).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  if (entries.length === 0) {
    fail('has an empty backend.inputBindings - remove the block to use the default mapping');
  }
  if (backend.method === 'GET' || backend.method === 'DELETE') {
    if (bindings.body !== undefined) {
      fail(
        `binds a request body on a ${backend.method}, which sends none - the value would be silently dropped`,
      );
    }
  }
  if (templated && bindings.path === undefined) {
    fail(
      'has backend.url path parameters but no "path" binding - in explicit binding mode nothing else supplies them, so every call would fail to reach the backend',
    );
  }

  const seen = new Map<string, string>();
  const properties = isRecord(input?.['properties']) ? input['properties'] : {};
  const required = new Set(
    Array.isArray(input?.['required'])
      ? input['required'].filter((value): value is string => typeof value === 'string')
      : [],
  );

  for (const [location, property] of entries) {
    if (RESERVED_INPUT_FIELDS.includes(property)) {
      fail(`binds "${location}" to "${property}", which is reserved by the gateway`, { location });
    }
    const other = seen.get(property);
    if (other !== undefined) {
      fail(`binds both "${other}" and "${location}" to the input property "${property}"`, {
        location,
        property,
      });
    }
    seen.set(property, location);

    if (!Object.hasOwn(properties, property)) {
      fail(
        `binds "${location}" to input property "${property}", which the input schema does not declare - the schema is closed, so a caller could never supply it`,
        { location, property },
      );
    }
    // `body` may be any JSON value; only the path and query groups are read as
    // name/value pairs
    const declared = properties[property];
    if (location !== 'body' && isRecord(declared) && !isObjectSchemaNode(declared)) {
      fail(
        `binds "${location}" to input property "${property}", which is not an object schema - ${location} parameters are read as an object of name/value pairs`,
        { location, property },
      );
    }
  }

  if (templated && bindings.path !== undefined && !required.has(bindings.path)) {
    fail(
      `binds path parameters to input property "${bindings.path}" without listing it in the input schema's "required" - a caller that omits it cannot supply any path parameter, so the request could never be built`,
      { property: bindings.path },
    );
  }

  if (bindings.path === undefined) return { schema: undefined, where: 'its input schema' };
  const group = properties[bindings.path];
  return {
    schema: isRecord(group) ? group : undefined,
    where: `input.properties.${bindings.path}`,
  };
}

// Strips absent optional keys so the result satisfies `exactOptionalPropertyTypes`
function pickDefined<T extends Record<string, string | undefined>>(
  value: T,
): { [K in keyof T]?: string } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: string;
  };
}

/**
 * Every `{param}` in `backend.url` must be declared in `properties` and listed
 * in `required`. Otherwise a call can arrive without it, and core's
 * `validateBackendRequestShape` rejects the request, which for a schema that
 * never declares the parameter means every call. Checked at load so
 * `validate` and `doctor` report it; the runtime check covers a hand-built
 * `CommerceResource`.
 */
function validatePathParametersDeclared(
  id: string,
  url: string,
  input: Record<string, unknown> | undefined,
  where: string,
): void {
  // A brace token the grammar does not recognize is neither extracted nor
  // substituted, so it would reach the backend as a percent-encoded literal
  const stray = findUnparsedBraceToken(url);
  if (stray !== undefined) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" has backend.url containing "${stray}", which is not a valid path parameter (allowed characters: A-Z a-z 0-9 _ . -). It would reach the backend as literal text, so a paid resource would take payment for a request the backend cannot serve`,
      { details: { path: `resources.${id}.backend.url`, resourceId: id, token: stray } },
    );
  }

  const params = extractPathParameterNames(url);
  if (params.length === 0) return;

  // Everything before the first `{` must be a complete origin followed by the
  // path's leading `/`. In the host, every other `{param}` defense fails open:
  // `http://{host}/api` parses, the runtime prefix check skips a prefix that
  // is not a URL, and `encodeURIComponent` keeps dots. Caller input would pick
  // the host the gateway calls, such as a metadata service or an internal
  // address, and `http://{region}.api.internal/...` looks ordinary enough to
  // be written by mistake.
  const firstBrace = url.indexOf('{');
  if (firstBrace !== -1) {
    const prefix = url.slice(0, firstBrace);
    let origin: string | undefined;
    try {
      const parsedPrefix = new URL(prefix);
      origin = parsedPrefix.hostname === '' ? undefined : parsedPrefix.origin;
    } catch {
      // Not a URL: the parameter starts before the authority is complete
    }
    if (origin === undefined || !prefix.startsWith(`${origin}/`)) {
      // The URL is not quoted: it may carry a key substituted from the environment
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" has a backend.url parameter before the end of the host. A caller-supplied value would choose which host the gateway calls, which is request forgery with the gateway's own network position. Parameters are supported inside the path and query only`,
        { details: { path: `resources.${id}.backend.url`, resourceId: id } },
      );
    }
  }

  const propertiesRaw = input?.['properties'];
  const properties = isRecord(propertiesRaw) ? propertiesRaw : {};
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
        `Resource "${id}" has backend.url path parameter "{${param}}" which is not declared in ${where} - the caller has no way to supply it, so every call would be refused`,
        { details: { path, resourceId: id, param } },
      );
    }
    if (!required.has(param)) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" has backend.url path parameter "{${param}}" declared in ${where} but not listed in its "required" - a call that omits it would be refused`,
        { details: { path, resourceId: id, param } },
      );
    }
  }
}

// `{param}` templates parse as URLs (the WHATWG parser percent-encodes the
// braces), so this refuses only malformed URLs and non-http(s) schemes
function validateBackendUrl(id: string, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // The URL is not quoted: it may carry a key substituted from the environment
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" has an invalid backend.url: must be an absolute http:// or https:// URL`,
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

// Checked with fetch's own `Headers` rules. Otherwise an illegal name, or a
// substituted value with a line break inside it, would load cleanly and then
// refuse every call. The error names the key, never the value, which may be a
// credential.
function validateBackendHeaders(id: string, headers: Record<string, string> | undefined): void {
  for (const [name, value] of Object.entries(headers ?? {})) {
    try {
      new Headers([[name, value]]);
    } catch {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" has backend header "${name}" with an illegal name or value (a name must be an HTTP token; a value must not contain NUL, a character above U+00FF, or a line break except at either end, which fetch trims)`,
        { details: { path: `resources.${id}.backend.headers.${name}`, resourceId: id } },
      );
    }
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
