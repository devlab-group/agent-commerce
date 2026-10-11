// The Zod schemas for `config.yaml`: shape only, before any business rule
import { type ZodTypeAny, z } from 'zod';
import { X402_PAYMENT_FLOWS } from '../../payments/x402/payment-flow';
import { ACP_WELL_KNOWN_PATH } from '../../protocols/acp/constants';

export const SUPPORTED_CONFIG_VERSION = 1;

// A number, or a numeric string from env substitution
const NumberOrString = z.union([z.number(), z.string()]);

// A boolean, or a "true"/"false" string from env substitution
const BooleanOrString = z.union([z.boolean(), z.string()]);

// An RPC endpoint. The message never echoes the value, which can carry an API key
const RpcUrl = z
  .string()
  .min(1)
  .refine(isHttpUrl, { message: 'must be an http:// or https:// URL' });

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

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

// Settlement network, payee and token, resolved by x402/options.ts. Network
// and payee fields follow the SDK's `PaymentOption`; asset fields override defaults
const X402OptionSchema = z
  .object({
    scheme: z.string().min(1).optional(),
    network: z.string().min(1),
    payTo: z.string().min(1),
    asset: z.string().min(1).optional(),
    assetName: z.string().min(1).optional(),
    assetVersion: z.string().min(1).optional(),
    assetDecimals: NumberOrString.optional(),
    assetTransferMethod: z.string().min(1).optional(),
  })
  .strict();

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
    paymentFlow: z.enum(X402_PAYMENT_FLOWS).optional(),
    // This resource's own x402 offers, in place of `payments.x402` options
    x402: z
      .object({ accepts: z.array(X402OptionSchema) })
      .strict()
      .optional(),
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

export const FacilitatorSchema = z.discriminatedUnion('mode', [
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

// Per-network settings: `kind` and `displayName` declare a network outside
// the registry; `rpcUrl` is that network's endpoint, built in or declared
const X402NetworkSettingsSchema = z
  .object({
    kind: z.enum(['testnet', 'mainnet']).optional(),
    displayName: z.string().min(1).optional(),
    rpcUrl: RpcUrl.optional(),
  })
  .strict();

const X402Schema = z
  .object({
    enabled: BooleanOrString,
    // Accept direct fields or an `options` array, never both
    network: z.string().min(1).optional(),
    payTo: z.string().min(1).optional(),
    asset: z.string().min(1).optional(),
    assetName: z.string().min(1).optional(),
    assetVersion: z.string().min(1).optional(),
    assetDecimals: NumberOrString.optional(),
    assetTransferMethod: z.string().min(1).optional(),
    options: z.array(X402OptionSchema).optional(),
    networks: z.record(z.string().min(1), X402NetworkSettingsSchema).optional(),
    // The RPC for every network without its own `networks.<id>.rpcUrl`
    rpcUrl: RpcUrl.optional(),
    maxTimeoutSeconds: NumberOrString,
    // `authorization` (the x402 default) settles after the backend call
    paymentFlow: z.enum(X402_PAYMENT_FLOWS).optional(),
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
    rpcUrl: RpcUrl,
    asset: z.string().min(1),
    assetName: z.string().min(1),
    assetVersion: z.string().min(1),
    recipient: z.string().min(1),
    realm: z.string().min(1),
    challengeSecret: z.string().min(1),
    challengeTtlSeconds: NumberOrString.optional(),
    // Same values as `payments.x402.paymentFlow`; the default is `upfront`
    paymentFlow: z.enum(X402_PAYMENT_FLOWS).optional(),
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

export const Ap2IssuerSchema = z
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
    requireMandateAudience: BooleanOrString.optional(),
    requireMandateExpiry: BooleanOrString.optional(),
    replay: z
      .object({ path: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

// Optional and off by default. The business pass requires the sub-blocks only
// when AP2 is enabled, and names the missing piece.
const AuthorizationSchema = z.object({ ap2: Ap2Schema.optional() }).strict();

export const RawConfigSchema = z
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

export type RawConfig = z.infer<typeof RawConfigSchema>;

export type RawResourceEntry = z.infer<typeof ResourceEntrySchema>;
