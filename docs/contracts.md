# Contract freeze record

The cross-package contract is `src/core/public-types.ts`.

- **Frozen:** at the contract freeze, for v0.1.0-alpha.
- **Change procedure:** written proposal (use case · desired change ·
  alternative considered · compatibility impact) → decision → edit the
  canonical file → update the decision record → consumers adapt. Never resolve
  a disagreement by creating a duplicate type.

## Frozen surface

| Type                                                                                                                                                                                                                                                             | File                                            | Consumed by                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------- |
| `CommerceResource`, `ResourceRegistry`, `BackendHandler`, `Pricing`                                                                                                                                                                                              | `domain/resource.ts`                            | config, gateway, mcp, cli, dx          |
| `PaymentRequirement`, `PaymentChallenge`, `PaymentSubmission`, `PaymentResult`, `PaymentProvider`, `PaymentContext`, `PaymentVerificationContext`, `PaymentSettlementContext`                                                                                    | `domain/payment.ts`                             | gateway, payment-x402, mcp, dx         |
| `CommerceReceipt`, `PaymentAttempt`                                                                                                                                                                                                                              | `domain/receipt.ts`                             | receipt-store, gateway, cli, dashboard |
| `CommerceEvent`, `CommerceEventType`, `EventSink`                                                                                                                                                                                                                | `domain/event.ts`                               | everything                             |
| `CanonicalRequest`, `ExecutionOutcome`, `DeliveredOutcome`, `PaymentRequiredOutcome`, `ExecutionPipeline`                                                                                                                                                        | `domain/request.ts`                             | gateway, mcp                           |
| `AuthorizationSubmission`, `AuthorizationRequirement`, `AuthorizationVerification`, `AuthorizationProvider`, `AuthorizationVerificationContext`, `AuthorizationFinalizeContext`                                                                                  | `domain/authorization.ts`                       | gateway, ap2, mcp, a2a                 |
| `AdapterDescriptor`, `AdapterHealth`, `JsonSchema`, `ProtocolName`, `PaymentMethodName`, `AuthorizationMethodName`, `DecimalAmount`, `IsoTimestamp`                                                                                                              | `domain/common.ts`                              | everything                             |
| `CommerceError`, `CommerceErrorCode`, `COMMERCE_ERROR_HTTP_STATUS`, `toCommerceError`, `isCommerceError`                                                                                                                                                         | `errors/**`                                     | everything                             |
| `ProtocolAdapter`, `HttpProtocolAdapter`, `ProtocolAdapterContext`                                                                                                                                                                                               | `interfaces/protocol-adapter.ts`                | gateway, mcp                           |
| `ReceiptStore`, `PaymentAttemptReservation`, `PaymentAttemptUpdate`, `ListOptions`                                                                                                                                                                               | `interfaces/store.ts`                           | receipt-store, gateway, cli            |
| `BackendExecutor`, `BackendRequest`, `BackendResponse`                                                                                                                                                                                                           | `interfaces/backend.ts`                         | core, gateway                          |
| `Logger`, `NOOP_LOGGER`, `Clock`, `IdGenerator`, `systemClock`                                                                                                                                                                                                   | `interfaces/logger.ts`, `interfaces/runtime.ts` | everything                             |
| `PaymentRequiredEnvelope`, `toPaymentRequiredEnvelope`, `isPaymentRequiredEnvelope`, `DeliverySummary`, `toDeliverySummary`, `DELIVERY_SUMMARY_META_KEY`, `ErrorEnvelope`, `toErrorEnvelope`, `PAYMENT_HEADER`, `PAYMENT_RESPONSE_HEADER`, `PAYMENT_INPUT_FIELD`, `AUTHORIZATION_INPUT_FIELD`, `AUTHORIZATION_HEADER`, `MAX_AUTHORIZATION_HEADER_BYTES`, `RESERVED_INPUT_FIELDS`, `parseAuthorizationSubmission`, `parseAuthorizationHeader`, `extractReservedInputFields` | `domain/wire.ts`                                | gateway, mcp, dx, demo                 |
| `COMMERCE_ERROR_CODES`, `COMMERCE_EVENT_TYPES`, `RETRYABLE_ERROR_CODES`, `DEFAULT_BACKEND_TIMEOUT_MS`, `isHttpProtocolAdapter`, `BackendMethod`, `CommerceErrorInfo`, `CommerceErrorOptions`                                                                     | `errors/**`, `domain/**`, `interfaces/**`       | everything                             |

**The authoritative enumeration is [`contract-surface.txt`](contract-surface.txt)**
- 85 symbols, generated by `scripts/contract-surface.mjs` from the barrel
itself and enforced by `npm run check:contract`. The table above groups them
for orientation; it is written by hand and was found under-enumerating in round
6 (the whole `domain/wire.ts` group was missing). If the two ever disagree,
the generated file is right and this table is stale.

## Assumptions every consumer must honour

1. `CanonicalRequest.requestId` is generated by the **protocol adapter** and is
   the correlation id for every log line, event, payment attempt and receipt in
   the flow.
2. `PaymentRequirement.challenge.accepts` is provider-native and opaque. Pass it
   through; do not reshape it.
3. `PaymentResult.replayKey` is derived **only** from the payment authorisation
   (payer, nonce, asset, network) - never from the request id - so that the same
   authorisation replayed against a different request still collides.
4. `PaymentProvider.verify` has no fund-moving side effects. Only `settle`
   moves money, and it runs only after a successful `verify` **and** a
   successful `reservePaymentAttempt`.
5. `EventSink.emit` and event persistence must never fail a commerce flow.
6. `BackendExecutor` is the only outbound HTTP path to merchant backends and
   always applies a timeout.
7. Amounts are decimal strings in display units ("0.01"); conversion to base
   units belongs to the payment provider.
8. `AuthorizationSubmission.payload` is preserved byte-for-byte from the wire.
   Providers derive a replay identity by hashing it, so decoding and
   reserialising it would give one proof two identities.
9. An authorization failure is never reported with a `PAYMENT_*` code. A 402
   tells a client to pay and retry, which cannot fix a missing or rejected
   mandate, and an auto-paying client would be charged for a request that was
   never going to be delivered.
10. `exactOptionalPropertyTypes` is on: build optional fields conditionally
   (`...(x !== undefined ? { x }: {})`), do not assign `undefined`.

## Change log

- Initial freeze (v0.1.0-alpha)
- UCP removed from scope; `ProtocolName` = `'http' | 'mcp'`
- `core` adds `./execution` subpath (non-frozen)
- `payment-x402` adds `./testing.js` subpath (non-frozen); becomes the canonical import path for `readLocalChainManifest`
- **Behaviour change (no type change):** `toCommerceError` no longer copies an arbitrary Error's `message` into the client-visible `message`. The original is kept on `cause`, which is never serialised. Found in the contract-freeze adversarial review.
- **Type change:** `PaymentAttempt.status` gains `'settlement-uncertain'`, so a broadcast-but-unconfirmed settlement is no longer recorded as `failed`.
- `gateway` adds `./well-known.js` subpath (non-frozen, type-only: re-exports `WellKnownDocument`) so `demo/dashboard`'s hand-maintained mirror of the `/.well-known/agent-commerce` shape can assert assignability at compile time instead of silently drifting - the mirror had already drifted twice with nothing catching it (most recently `rpcUrl`). Not a stable public API; exists only to make the mirror verifiable.
- **Additive:** `GATEWAY_BUSY` error code (503, retryable). Load shedding is transient; the MCP queue-full path was throwing `PROTOCOL_UNSUPPORTED` (501, non-retryable), telling clients a throttle was a permanent capability gap.
- **Additive:** `ReceiptStore.countUndeliveredReceipts`. A paid-but-undelivered purchase was indistinguishable from a successful one in every operator-facing view; the record was truthful but nothing read it.
- **Additive:** `ReceiptStore.countReceipts`. Counting by list length saturated at the store's own list clamp, so `doctor` reported a frozen 500.
- **Additive:** `DELIVERY_SUMMARY_META_KEY` - the `_meta` key adapters attach the summary under. Frozen so producer and consumer cannot drift on the string.
- **Value change (no type change):** `DELIVERY_SUMMARY_META_KEY` is now `agent-commerce/delivery`. The wire identifiers were realigned with the `/.well-known/agent-commerce` route and the package name; safe only because no release exists yet for a client to have matched against.
- **Additive:** `DeliverySummary` + `toDeliverySummary`. A payer is entitled to the record of their own purchase without reading the merchant's ledger. HTTP already sent one via the payment-response header; MCP sent nothing, which is why the demo buyer had to call the (now authenticated) `/api/receipts`.
- **Value change + additive (x402 v2):** `PAYMENT_HEADER` is now `payment-signature` and `PAYMENT_RESPONSE_HEADER` is now `payment-response`, matching the x402 v2 HTTP binding; the v1 `x-payment` / `x-payment-response` pair is no longer accepted. New `PAYMENT_REQUIRED_HEADER` (`payment-required`) carries the base64 challenge on a 402. Wire-breaking by definition, and safe only because no release exists yet.
- **Additive:** `PaymentChallenge.envelope` and `PaymentRequiredEnvelope.payment.envelope` - the provider's own challenge document, verbatim (x402 v2's `PaymentRequired`). `accepts` is the offer list inside it; the envelope also carries the protocol version and the resource description that v1 kept per-requirement. Built once by the provider so the HTTP and MCP surfaces cannot describe different challenges.
- **Type change (x402, non-frozen surface):** `X402ProviderOptions.facilitator` is now `X402FacilitatorConfig`; `mode: 'remote'` gained a required `auth`, and `allowMainnet` was added. `mode: 'remote'` previously parsed but was rejected at config load and threw `PROTOCOL_UNSUPPORTED` at request time, so no working configuration changes shape.
- **Additive:** `ProtocolName` gains `'a2a'`; config gains `protocols.a2a` (disabled by default, mount `/a2a`) and accepts `expose: [a2a]`.
- **Additive:** `AdapterHttpRoute` and the optional `HttpProtocolAdapter.additionalHttpRoutes`. A protocol whose specification pins a discovery URL outside the adapter's mount (A2A's `/.well-known/agent-card.json`) declares it instead of the gateway growing a per-protocol route conditional. Fixed routes get the mount's guarantees - unconsumed body, concurrency cap, failure isolation - and two adapters claiming one path is rejected before either starts.
- **Removed from the wire:** `/.well-known/agent-commerce` no longer publishes `payments.x402.facilitator.url`. A facilitator endpoint can carry a tenant path or an API key, exactly like `rpcUrl`, which the same route already withholds. It gained `payments.x402.mode` (`local` | `testnet` | `mainnet`) instead - chain id 84532 belongs to both the local dev chain and public Base Sepolia, so the network id alone cannot say which one a client is talking to.
- **Additive:** optional `BackendHandler.inputBindings` (`{ path?, query?, body? }`), naming the top-level input properties that carry each part of the backend request. *Use case:* `POST /users/{userId}/orders?notify=true` with a JSON body - path, query and body at once - which the leftover rule cannot express, because on a body-capable method everything not consumed by the URL template becomes the body. *Alternative considered:* infer the split from the input schema's property names; rejected, since the shape a merchant's backend expects is operator configuration, not something to guess from a schema, and guessing wrong on a paid resource is payment-without-delivery. *Compatibility:* absent means the legacy mapping, byte-for-byte; no consumer changes. When present, only named groups are forwarded - unmapped top-level input never reaches the backend. `validateBackendRequestShape` resolves both modes through the same function, so every shape error (missing/invalid path parameter, non-object group, query collision with the configured URL) is still an `INPUT_INVALID` raised before pricing.
- **Additive:** `PROTOCOL_NAMES`, the `ProtocolName` values as a runtime array. *Use case:* config validation and the OpenAPI importer's `--expose` both have to check a protocol name at runtime, and config was carrying its own hardcoded `new Set(['http','mcp','a2a'])`. *Alternative considered:* deriving `ProtocolName` from the array instead; rejected because it makes the surface printer expand the type into a literal union at every use site, turning a no-op into a noisy contract diff. *Compatibility:* additive value export, typed `readonly ProtocolName[]` so an unsupported name cannot enter it. No consumer changes.
- **Additive:** `ProtocolName` gains `'acp'` (experimental); config gains `protocols.acp` (disabled by default, mount `/acp`) and accepts `expose: [acp]`. *Use case:* the ACP checkout adapter. *Shape:* unlike `mcp`/`a2a`, the normalised `protocols.acp` is discriminated on `enabled` - an enabled block carries `auth`, `idempotency` and all five `checkout.operations` mappings, so the adapter needs no optional-field assertions and a half-configured checkout lifecycle is refused at load rather than advertised through ACP discovery. *Compatibility:* additive union member; a config with no `protocols.acp` block parses unchanged.
- **Additive (main entry):** `createAcpAdapter`, `AcpAdapterOptions`, `ACP_SPEC_VERSION`, `ACP_API_VERSION`, `ACP_WELL_KNOWN_PATH`. *Use case:* a consumer running `createGateway` needs the adapter to mount. *Why the main entry and not a subpath:* a subpath is a peer-dependency boundary, not a category - the ACP adapter needs no peer, only `ajv`/`ajv-formats` (real dependencies) and its own vendored schema. *Cost:* the pinned schema is inlined into `dist/index.js` (+~124 kB; package 396 kB -> 479 kB). The CLI bundle is unaffected - `doctor` reads only the ACP constants and descriptor, never the validator.
- **Additive:** the generic authorization contract - `AuthorizationMethodName` (`'ap2'`), `AuthorizationSubmission`, `AuthorizationRequirement`, `AuthorizationVerification`, `AuthorizationProvider` and its two contexts; optional `CanonicalRequest.authorization`, optional `CommerceResource.authorization`, optional `PaymentRequiredOutcome.authorization` and the matching `PaymentRequiredEnvelope.authorization`; `AdapterDescriptor.kind` gains `'authorization'`; four `AUTHORIZATION_*` error codes (403 / 403 / 409 / 503, the last retryable); and the wire carriers `AUTHORIZATION_INPUT_FIELD` (`_authorization`), `AUTHORIZATION_HEADER` (`agent-authorization`), `MAX_AUTHORIZATION_HEADER_BYTES` and `RESERVED_INPUT_FIELDS`. *Use case:* AP2 mandate verification - proving the human behind an agent approved this exact purchase, a separate question from whether the payment verified. *Why generic:* AP2 is the first implementation, not the abstraction. Core states that a resource requires authorization and when the pipeline checks it, and knows nothing about SD-JWTs. An authorization method is deliberately neither a `ProtocolName` nor a `PaymentMethodName`, because it is not a transport and must never be selectable as a payment rail. *Compatibility:* every field is optional and every consumer that sets none behaves exactly as before; a resource with no `authorization` policy is unchanged end to end. `extractReservedInputFields` replaces the two hand-written `_payment` extractors in the MCP and A2A adapters with one path in core, so the reserved-field list cannot drift between surfaces. `_payment` handling is byte-identical, including dropping a proof for a resource with no configured rail.
- **Additive:** `AuthorizationRecord`; optional `CommerceReceipt.authorization`; `AuthorizationProvider` gains `requirement` and `markUncertain`; `AuthorizationVerification` now extends `AuthorizationRecord`; `CommerceEventType` gains `authorization.verified` and `authorization.rejected`. *Use case:* the execution pipeline enforcing authorization, in the order payment verify -> authorize/reserve -> payment replay reserve -> settle -> consume/release/mark-uncertain. *Why `requirement` on the provider:* the 402 challenge has to name what the retry must also carry, and only the provider knows its own spec version and payload profile. *Why `markUncertain` rather than leaving a reservation alone:* a settlement that was broadcast but never confirmed must not hand the proof back, and "we did nothing" is indistinguishable from a path that forgot to finalize. *Why the receipt stores a record and not the verification:* `reservationId` is a live handle, not an audit fact, and a stored proof would be a spendable secret at rest. *Compatibility:* `CommerceReceipt.authorization` is optional and absent for every resource that requires no authorization; the receipt store adds schema version 2 (`ALTER TABLE receipts ADD COLUMN authorization_json`), so an existing database keeps its rows. `AuthorizationProvider` is not yet implemented by anything shipped, so the two new members break no consumer.
- **Additive (non-frozen surfaces):** `GatewayOptions.authorizationProviders` (optional) and `ReadinessResult.authorizationProviders`; a new `./ap2` subpath exporting `createAp2AuthorizationProvider` / `ap2`, with `jose`, `@sd-jwt/core` and `canonicalize` as optional peers. *Use case:* running AP2 as a wired subsystem. *Why a subpath:* one entry per distinct peer set, named for the peer - a gateway serving no gated resource should install neither a JOSE stack nor an SD-JWT parser, and the main entry and the CLI import the narrow AP2 modules (`constants.ts`, `types.ts`, `descriptor.ts`) so neither pulls a peer. *Readiness:* an authorization provider reporting `fail` blocks `/ready` on the same threshold as a payment provider - a resource that requires a mandate cannot be served without one, and serving its challenge anyway promises what cannot be honoured. Only the fixed vocabulary token `authorization-provider-unreachable` reaches the client. *Compatibility:* both fields are additive and a deployment configuring no authorization behaves exactly as before.
- **Additive (`./ap2` subpath):** `createCheckoutJwt` and `CreateCheckoutJwtOptions`. *Use case:* a merchant has to sign the checkout JWT a Checkout Mandate binds, and the gateway only verifies. *Why it ships:* `input_hash` is an RFC 8785 digest, and a hand-rolled signer reaching for a sorted-key `JSON.stringify` agrees on most inputs and disagrees on floats and non-ASCII keys - producing a mandate refused with a deliberately coarse reason. The helper also refuses a numeric `amount`, the public half of a key pair, a non-P-256 key and a missing field before signing, rather than letting each become that same opaque refusal. *Scope:* signing only. It runs in the merchant's process, never calls the gateway and is never called by it - the mirror of `createPaymentProof`. The Checkout Mandate itself is the buyer's side and nothing here mints one.
- **Additive:** optional `CanonicalRequest.idempotencyKey` and optional `BackendRequest.idempotencyKey`; the HTTP backend executor forwards the latter as the `Idempotency-Key` request header. *Use case:* a merchant that creates an order and then loses the response to a timeout or a 5xx had no way to recognise the retry that followed as the same operation, so one ACP checkout became two orders. *Why not `requestId`:* it is generated per call, so every retry would look like new work; the ACP adapter derives this one from its idempotency scope (deployment, endpoint, caller key), which is identical across a client retry, a reconnect, a gateway restart and a bearer-token rotation. *Why hashed rather than forwarded raw:* the caller's key alone does not name an operation. ACP scopes it per endpoint, so one client may legitimately send the same key to create and to complete, and a merchant keying state on the raw value would read those as one operation; the digest folds deployment, endpoint and key into the single header ACP provides. It does not separate two clients that picked the same key - they share a deployment and an endpoint, so they share a derived key, exactly as they already share a row in the local claim store. *Why a fixed header and not config:* `Idempotency-Key` is the de-facto standard and the same header ACP already mandates inbound, so a merchant speaking ACP needs no second convention; a configurable name can be added if a real backend needs one. A statically configured header of that name is overridden rather than deferred to: a fixed key would make every request after the first look like a retry of the first. *Compatibility:* both fields are optional, every adapter that sets neither behaves exactly as before, and a merchant sees no new header unless one is supplied.
- **Additive (gateway wire surface):** `WellKnownDocument.authorizationProviders`, an `AdapterDescriptor[]` that is empty unless a resource requires authorization. *Use case:* the README promises every adapter's `supportedSpec`, `capabilities` and `unsupported` list is checkable at runtime rather than taken on trust, and AP2 was reportable through `doctor` but absent from the document. *Why a separate field and not `paymentProviders`:* an authorization method is not a payment rail and must never be selectable as one - the same reason `AuthorizationMethodName` is neither a `ProtocolName` nor a `PaymentMethodName`. *Compatibility:* additive; the field is always present, and the dashboard's hand-maintained mirror carries only what it renders, as it already does for `protocols.acp`.
---

# Integration contract - exact factory signatures

The gateway composition root (`src/gateway/main.ts`) wires the concrete
implementations together. Every module below must export **exactly** these
names with **exactly** these signatures, so integration needs no
renegotiation.

## `src/storage/receipts`
```ts
export interface SqliteReceiptStoreOptions {
  /** File path, or ':memory:' for tests. Parent directory is created if missing. */
  readonly path: string;
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}
export function createSqliteReceiptStore(
  options: SqliteReceiptStoreOptions,
): ReceiptStore;
```

`reservePaymentAttempt` must be atomic and must throw
`new CommerceError('PAYMENT_REPLAYED', …)` on a duplicate `replayKey`.

## `src/payments/x402`
> **Published as** `@devlab.group/agent-commerce/x402`, gated behind the optional peers
> `x402` and `viem` (~648 MB of install weight between them). In-repo consumers
> keep importing it by relative path. Nothing about the factory signatures
> below changes.

```ts
export interface X402ProviderOptions {
  /** CAIP-2 network identifier. Local deterministic chain uses 'eip155:84532'. */
  readonly network: string;
  /** RPC endpoint. Local chain: http://127.0.0.1:8545 */
  readonly rpcUrl: string;
  /** ERC-20 (EIP-3009) asset address used for settlement. */
  readonly asset: `0x${string}`;
  /** EIP-712 domain name of the asset, e.g. 'MockUSDC'. */
  readonly assetName: string;
  /** EIP-712 domain version of the asset, e.g. '2'. */
  readonly assetVersion: string;
  readonly assetDecimals: number;
  /** Merchant-controlled settlement destination. Never gateway-owned. */
  readonly payTo: `0x${string}`;
  readonly maxTimeoutSeconds?: number;
  /**
   * `local` runs the facilitator in this process and signs with an Anvil
   * well-known key - LOCAL DEVELOPMENT ONLY - DO NOT FUND. `remote` calls an
   * HTTP facilitator, and this gateway then holds no signing key at all.
   */
  readonly facilitator: X402FacilitatorConfig;
  /** Required to be `true` before anything settles on a mainnet. Never a default. */
  readonly allowMainnet?: boolean;
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}
export function createX402PaymentProvider(options: X402ProviderOptions): PaymentProvider;

export type FacilitatorAuth =
  | { readonly type: 'none' }
  | { readonly type: 'bearer'; readonly token: string };

export type X402FacilitatorConfig =
  | { readonly mode: 'local'; readonly signerPrivateKey: string }
  | { readonly mode: 'remote'; readonly url: string; readonly auth: FacilitatorAuth };

export type DeploymentMode = 'local' | 'testnet' | 'mainnet';
export const SUPPORTED_NETWORK_IDS: readonly string[]; // ['eip155:84532', 'eip155:8453']
```

## `src/authorization/ap2`
> **Published as** `@devlab.group/agent-commerce/ap2`, gated behind the optional
> peers `jose`, `@sd-jwt/core` and `canonicalize`. The main entry and the CLI
> import only the narrow modules (`constants.ts`, `types.ts`, `descriptor.ts`),
> which pull no peer, so `doctor` can report AP2 without installing a JOSE
> stack. Trust and config types live here rather than in `src/config`, the way
> `X402FacilitatorConfig` does: the subsystem owns its own config shape and the
> loader imports it.

```ts
export interface Ap2AuthorizationProviderOptions {
  /** The enabled half of the parsed `authorization.ap2` block. */
  readonly config: EnabledAp2Config;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** Injectable so tests need not touch the filesystem. */
  readonly replayStore?: Ap2ReplayStore;
}

/** The gateway owns the lifetime: `close()` releases the replay database. */
export interface Ap2AuthorizationProvider extends AuthorizationProvider {
  close(): void;
}
export function createAp2AuthorizationProvider(
  options: Ap2AuthorizationProviderOptions,
): Ap2AuthorizationProvider;

export type Ap2AuthorizationConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly specVersion: '0.2.0';
      readonly mode: 'direct';
      readonly trust: {
        /** Signers of the Checkout Mandate itself. */
        readonly mandateIssuers: readonly Ap2TrustedIssuer[];
        /** Signers of the merchant checkout JWT the mandate binds. */
        readonly checkoutIssuers: readonly Ap2TrustedIssuer[];
      };
      readonly clockSkewSeconds: number;
      /** Its own SQLite file. An authorization replay is not a payment replay. */
      readonly replay: { readonly path: string };
    };

export interface Ap2TrustedIssuer {
  readonly issuer: string;
  /** Per issuer, not gateway-wide: the mandate is addressed to the merchant. */
  readonly audience: string;
  readonly keys: readonly Ap2TrustedKey[];
}
export interface Ap2TrustedKey {
  readonly kid: string;
  /** A public P-256 JWK, validated member by member at config load. */
  readonly jwk: Readonly<Record<string, string>>;
}

/** Merchant-side. Signs the checkout JWT a Checkout Mandate binds. */
export interface CreateCheckoutJwtOptions {
  /** A private ES256 JWK, or a PKCS#8 PEM. Never leaves the caller's process. */
  readonly privateKey: Ap2SigningKey;
  readonly kid: string;
  readonly issuer: string;
  readonly audience: string;
  readonly resourceId: string;
  /** Hashed with RFC 8785 (JCS), the same way the gateway hashes it. */
  readonly input: unknown;
  /** A decimal string; compared as a string, never numerically. */
  readonly amount: string;
  readonly currency: string;
  readonly paymentMethod: string;
  readonly destination?: string;
  readonly network?: string;
  readonly asset?: string;
  readonly jwtId?: string;
  readonly expiresInSeconds?: number;
  readonly now?: Date;
}
export function createCheckoutJwt(options: CreateCheckoutJwtOptions): Promise<string>;

export const AP2_SPEC_VERSION = '0.2.0';
export const AP2_CHECKOUT_PROFILE = 'agent-commerce/ap2/checkout/v1';
export const AP2_CAPABILITIES: readonly string[];
export const AP2_UNSUPPORTED: readonly string[];
```

## `src/protocols/mcp`
> **Published as** `@devlab.group/agent-commerce/mcp`, gated behind the optional peer
> `@modelcontextprotocol/sdk`. In-repo consumers keep importing it by relative
> path; the subpath exists so a consumer who does not speak MCP does not
> install the SDK. Nothing about the factory signature below changes.

```ts
export interface McpAdapterOptions {
  readonly mountPath?: string; // default '/mcp'
  readonly serverName?: string; // default 'agent-commerce'
  readonly serverVersion?: string; // default the package version
}
export function createMcpAdapter(options?: McpAdapterOptions): HttpProtocolAdapter;
```

## `src/gateway`
```ts
export interface GatewayOptions {
  readonly config: GatewayConfig; // from src/config
  readonly store: ReceiptStore;
  readonly paymentProviders: readonly PaymentProvider[];
  // Absent means no resource requires authorization, which is the default
  readonly authorizationProviders?: readonly AuthorizationProvider[];
  readonly protocolAdapters: readonly ProtocolAdapter[];
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly backend?: BackendExecutor; // override for tests
}
export function createGateway(options: GatewayOptions): Promise<GatewayInstance>;

export interface GatewayInstance {
  readonly pipeline: ExecutionPipeline;
  readonly resources: ResourceRegistry;
  listen: Promise<{ url: string }>;
  close: Promise<void>;
  /** Fastify instance, for `.inject` in tests. */
  readonly server: FastifyInstance;
}
```

## `src/config`
```ts
export function loadConfig(options?: {
  path?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<GatewayConfig>;

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv): GatewayConfig;

/** Validated, env-substituted configuration. */
export interface GatewayConfig {
  readonly version: 1;
  readonly merchant: { id: string; name: string; publicBaseUrl: string };
  readonly server: {
    port: number;
    host: string;
    /** Gates the operator (ledger) routes. Unset => those routes 404. */
    adminToken?: string;
    /** Browser origins permitted to read the gateway. Empty => none. */
    allowedOrigins: readonly string[];
  };
  readonly storage: { receipts: { driver: 'sqlite'; path: string } };
  readonly protocols: {
    http: { enabled: boolean };
    mcp: { enabled: boolean; mountPath: string };
  };
  /** Canonical resources, already normalised. */
  readonly resources: readonly CommerceResource[];
  readonly payments: {
    readonly x402?: {
      enabled: boolean;
      network: string;
      rpcUrl: string;
      asset: string;
      assetName: string;
      assetVersion: string;
      assetDecimals: number;
      payTo: string;
      maxTimeoutSeconds: number;
      facilitator: X402FacilitatorConfig;
      allowMainnet?: boolean;
    };
  };
}
```

## Gateway HTTP surface
| Route                              | Purpose                                                                                                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                      | liveness - always 200 when the process is up                                                                                                                                                 |
| `GET /ready`                       | readiness - 200 only when config, store, every required adapter, **every configured payment provider and every authorization provider** are healthy (`fail` blocks; `warn` is degraded-but-serving) |
| `GET /.well-known/agent-commerce`  | merchant, adapter, payment-provider and authorization-provider descriptors, protocol/spec versions                                                                                            |
| `GET /api/resources`               | canonical resource list (no secrets)                                                                                                                                                         |
| `POST /api/resources/:id/invoke`   | HTTP protocol surface; `PAYMENT-SIGNATURE` header carries the proof; 402 + `PaymentRequiredEnvelope` body and `PAYMENT-REQUIRED` header when unpaid; `PAYMENT-RESPONSE` header on settlement |
| `GET /api/receipts?limit=`         | recent receipts (dashboard/CLI)                                                                                                                                                              |
| `GET /api/events?limit=`           | recent events (dashboard/CLI)                                                                                                                                                                |
| `GET /api/events/stream`           | Server-Sent Events feed of `CommerceEvent`                                                                                                                                                   |
| `<mcp.mountPath>` (default `/mcp`) | MCP Streamable HTTP, delegated to the adapter                                                                                                                                                |

## Local chain deployment manifest
`npm run chain:deploy` writes `.deploy/local.json` (git-ignored). Everything else
reads it - no hard-coded addresses anywhere else:

```json
{
  "chainId": 84532,
  "rpcUrl": "http://127.0.0.1:8545",
  "hostRpcUrl": "http://127.0.0.1:8545",
  "asset": "0x...",
  "assetName": "MockUSDC",
  "assetVersion": "2",
  "assetDecimals": 6,
  "merchant": { "address": "0x...", "privateKeyLabel": "LOCAL DEVELOPMENT ONLY - DO NOT FUND" },
  "buyer": { "address": "0x...", "privateKey": "0x...", "note": "LOCAL DEVELOPMENT ONLY - DO NOT FUND" },
  "facilitator": { "address": "0x...", "privateKey": "0x...", "note": "LOCAL DEVELOPMENT ONLY - DO NOT FUND" },
  "buyerInitialBalance": "100.00"
}
```

Also available programmatically. There is exactly one implementation, in
`src/payments/x402/local-chain/manifest.ts`; `scripts/chain/manifest.ts` and
`src/payments/x402/testing.ts` both re-export it, so there is never a second
copy to drift.

```ts
// src/payments/x402/local-chain/manifest.ts - the one implementation
export interface LocalChainManifest { /* as above */ }
export function readLocalChainManifest(cwd?: string): LocalChainManifest; // throws if absent

// `rpcUrl` is the endpoint the deployer used. Inside docker-compose that is
// `http://anvil:8545`, which the host cannot resolve. `hostRpcUrl` is the same
// chain addressed the way the host reaches it (the published port), written
// from HOST_RPC_URL when set and falling back to `rpcUrl` otherwise.
// Host-side consumers must prefer `hostRpcUrl ?? rpcUrl`.
export const LOCAL_CHAIN_MANIFEST_PATH = '.deploy/local.json';
```

In-repo consumers - the demo agent and the E2E suite - import it through
`testing.ts`, by relative path:

```ts
import {
  type LocalChainManifest,
  LOCAL_CHAIN_MANIFEST_PATH,
  readLocalChainManifest,
} from '<relative>/src/payments/x402/testing.js';
```

`testing.ts` is test- and deploy-only. No public entry point re-exports it, so
a published consumer cannot import it - enforced by the module graph rather
than by convention. The frozen provider surface is unchanged:
`createX402PaymentProvider` and `createPaymentProof`.

## Client-side payment helper
The buyer side of x402 lives in one place so the demo agent and the E2E suite
cannot drift from the gateway's expectations. It is a **client** helper: the
gateway never calls it and never holds a buyer key.

```ts
// src/payments/x402/client.ts
export interface CreatePaymentProofOptions {
  /** Buyer's dev-only private key. LOCAL DEVELOPMENT ONLY - DO NOT FUND. */
  readonly buyerPrivateKey: `0x${string}`;
  readonly rpcUrl: string;
  /** One entry from PaymentRequiredEnvelope.payment.accepts, verbatim. */
  readonly accepts: Readonly<Record<string, unknown>>;
  /** Overrides used only by negative tests (wrong amount/recipient/nonce…). */
  readonly overrides?: {
    readonly value?: string;
    readonly payTo?: string;
    readonly nonce?: `0x${string}`;
    readonly validBefore?: number;
    readonly validAfter?: number;
  };
}

/** Returns the base64 `PAYMENT-SIGNATURE` value to send back to the gateway. */
export function createPaymentProof(options: CreatePaymentProofOptions): Promise<string>;
```

## Composition root

`src/gateway/main.ts` is the integration file, written once every factory
above exists. `createGateway` must be fully usable - and tested - with fakes,
without `main.ts`.
