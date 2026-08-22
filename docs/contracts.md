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
| `AdapterDescriptor`, `AdapterHealth`, `JsonSchema`, `ProtocolName`, `PaymentMethodName`, `DecimalAmount`, `IsoTimestamp`                                                                                                                                         | `domain/common.ts`                              | everything                             |
| `CommerceError`, `CommerceErrorCode`, `COMMERCE_ERROR_HTTP_STATUS`, `toCommerceError`, `isCommerceError`                                                                                                                                                         | `errors/**`                                     | everything                             |
| `ProtocolAdapter`, `HttpProtocolAdapter`, `ProtocolAdapterContext`                                                                                                                                                                                               | `interfaces/protocol-adapter.ts`                | gateway, mcp                           |
| `ReceiptStore`, `PaymentAttemptReservation`, `PaymentAttemptUpdate`, `ListOptions`                                                                                                                                                                               | `interfaces/store.ts`                           | receipt-store, gateway, cli            |
| `BackendExecutor`, `BackendRequest`, `BackendResponse`                                                                                                                                                                                                           | `interfaces/backend.ts`                         | core, gateway                          |
| `Logger`, `NOOP_LOGGER`, `Clock`, `IdGenerator`, `systemClock`                                                                                                                                                                                                   | `interfaces/logger.ts`, `interfaces/runtime.ts` | everything                             |
| `PaymentRequiredEnvelope`, `toPaymentRequiredEnvelope`, `isPaymentRequiredEnvelope`, `DeliverySummary`, `toDeliverySummary`, `DELIVERY_SUMMARY_META_KEY`, `ErrorEnvelope`, `toErrorEnvelope`, `PAYMENT_HEADER`, `PAYMENT_RESPONSE_HEADER`, `PAYMENT_INPUT_FIELD` | `domain/wire.ts`                                | gateway, mcp, dx, demo                 |
| `COMMERCE_ERROR_CODES`, `COMMERCE_EVENT_TYPES`, `RETRYABLE_ERROR_CODES`, `DEFAULT_BACKEND_TIMEOUT_MS`, `isHttpProtocolAdapter`, `BackendMethod`, `CommerceErrorInfo`, `CommerceErrorOptions`                                                                     | `errors/**`, `domain/**`, `interfaces/**`       | everything                             |

**The authoritative enumeration is [`contract-surface.txt`](contract-surface.txt)**
— 68 symbols, generated by `scripts/contract-surface.mjs` from the barrel
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
   (payer, nonce, asset, network) — never from the request id — so that the same
   authorisation replayed against a different request still collides.
4. `PaymentProvider.verify` has no fund-moving side effects. Only `settle`
   moves money, and it runs only after a successful `verify` **and** a
   successful `reservePaymentAttempt`.
5. `EventSink.emit` and event persistence must never fail a commerce flow.
6. `BackendExecutor` is the only outbound HTTP path to merchant backends and
   always applies a timeout.
7. Amounts are decimal strings in display units ("0.01"); conversion to base
   units belongs to the payment provider.
8. `exactOptionalPropertyTypes` is on: build optional fields conditionally
   (`...(x !== undefined ? { x }: {})`), do not assign `undefined`.

## Change log

- Initial freeze (v0.1.0-alpha)
- UCP removed from v0.1 scope; `ProtocolName` = `'http' | 'mcp'`
- `core` adds `./execution` subpath (non-frozen)
- `payment-x402` adds `./testing.js` subpath (non-frozen); becomes the canonical import path for `readLocalChainManifest`
- **Behaviour change (no type change):** `toCommerceError` no longer copies an arbitrary Error's `message` into the client-visible `message`. The original is kept on `cause`, which is never serialised. Found in the contract-freeze adversarial review.
- **Type change:** `PaymentAttempt.status` gains `'settlement-uncertain'`, so a broadcast-but-unconfirmed settlement is no longer recorded as `failed`.
- `gateway` adds `./well-known.js` subpath (non-frozen, type-only: re-exports `WellKnownDocument`) so `demo/dashboard`'s hand-maintained mirror of the `/.well-known/agent-commerce` shape can assert assignability at compile time instead of silently drifting — the mirror had already drifted twice with nothing catching it (most recently `rpcUrl`). Not a stable public API; exists only to make the mirror verifiable.
- **Additive:** `GATEWAY_BUSY` error code (503, retryable). Load shedding is transient; the MCP queue-full path was throwing `PROTOCOL_UNSUPPORTED` (501, non-retryable), telling clients a throttle was a permanent capability gap.
- **Additive:** `ReceiptStore.countUndeliveredReceipts`. A paid-but-undelivered purchase was indistinguishable from a successful one in every operator-facing view; the record was truthful but nothing read it.
- **Additive:** `ReceiptStore.countReceipts`. Counting by list length saturated at the store's own list clamp, so `doctor` reported a frozen 500.
- **Additive:** `DELIVERY_SUMMARY_META_KEY` — the `_meta` key adapters attach the summary under. Frozen so producer and consumer cannot drift on the string.
- **Value change (no type change):** `DELIVERY_SUMMARY_META_KEY` is now `agent-commerce/delivery`. The wire identifiers were realigned with the `/.well-known/agent-commerce` route and the package name; safe only because no release exists yet for a client to have matched against.
- **Additive:** `DeliverySummary` + `toDeliverySummary`. A payer is entitled to the record of their own purchase without reading the merchant's ledger. HTTP already sent one via the payment-response header; MCP sent nothing, which is why the demo buyer had to call the (now authenticated) `/api/receipts`.
- **Value change + additive (x402 v2):** `PAYMENT_HEADER` is now `payment-signature` and `PAYMENT_RESPONSE_HEADER` is now `payment-response`, matching the x402 v2 HTTP binding; the v1 `x-payment` / `x-payment-response` pair is no longer accepted. New `PAYMENT_REQUIRED_HEADER` (`payment-required`) carries the base64 challenge on a 402. Wire-breaking by definition, and safe only because no release exists yet.
- **Additive:** `PaymentChallenge.envelope` and `PaymentRequiredEnvelope.payment.envelope` — the provider's own challenge document, verbatim (x402 v2's `PaymentRequired`). `accepts` is the offer list inside it; the envelope also carries the protocol version and the resource description that v1 kept per-requirement. Built once by the provider so the HTTP and MCP surfaces cannot describe different challenges.
---

# Integration contract — exact factory signatures

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
   * Local facilitator: signer broadcasts settlement on the dev chain only.
   * LOCAL DEVELOPMENT ONLY — DO NOT FUND.
   */
  readonly facilitator:
    | { readonly mode: 'local'; readonly signerPrivateKey: `0x${string}` }
    | { readonly mode: 'remote'; readonly url: string };
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}
export function createX402PaymentProvider(options: X402ProviderOptions): PaymentProvider;
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
      facilitator:
        | { mode: 'local'; signerPrivateKey: string }
        | { mode: 'remote'; url: string };
    };
  };
}
```

## Gateway HTTP surface
| Route                              | Purpose                                                                                                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                      | liveness — always 200 when the process is up                                                                                                                                                 |
| `GET /ready`                       | readiness — 200 only when config, store, every required adapter **and every configured payment provider** are healthy (`fail` blocks; `warn` is degraded-but-serving)                        |
| `GET /.well-known/agent-commerce`  | merchant + adapter descriptors, protocol/spec versions                                                                                                                                       |
| `GET /api/resources`               | canonical resource list (no secrets)                                                                                                                                                         |
| `POST /api/resources/:id/invoke`   | HTTP protocol surface; `PAYMENT-SIGNATURE` header carries the proof; 402 + `PaymentRequiredEnvelope` body and `PAYMENT-REQUIRED` header when unpaid; `PAYMENT-RESPONSE` header on settlement |
| `GET /api/receipts?limit=`         | recent receipts (dashboard/CLI)                                                                                                                                                              |
| `GET /api/events?limit=`           | recent events (dashboard/CLI)                                                                                                                                                                |
| `GET /api/events/stream`           | Server-Sent Events feed of `CommerceEvent`                                                                                                                                                   |
| `<mcp.mountPath>` (default `/mcp`) | MCP Streamable HTTP, delegated to the adapter                                                                                                                                                |

## Local chain deployment manifest
`npm run chain:deploy` writes `.deploy/local.json` (git-ignored). Everything else
reads it — no hard-coded addresses anywhere else:

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
// src/payments/x402/local-chain/manifest.ts — the one implementation
export interface LocalChainManifest { /* as above */ }
export function readLocalChainManifest(cwd?: string): LocalChainManifest; // throws if absent

// `rpcUrl` is the endpoint the deployer used. Inside docker-compose that is
// `http://anvil:8545`, which the host cannot resolve. `hostRpcUrl` is the same
// chain addressed the way the host reaches it (the published port), written
// from HOST_RPC_URL when set and falling back to `rpcUrl` otherwise.
// Host-side consumers must prefer `hostRpcUrl ?? rpcUrl`.
export const LOCAL_CHAIN_MANIFEST_PATH = '.deploy/local.json';
```

In-repo consumers — the demo agent and the E2E suite — import it through
`testing.ts`, by relative path:

```ts
import {
  type LocalChainManifest,
  LOCAL_CHAIN_MANIFEST_PATH,
  readLocalChainManifest,
} from '<relative>/src/payments/x402/testing.js';
```

`testing.ts` is test- and deploy-only. No public entry point re-exports it, so
a published consumer cannot import it — enforced by the module graph rather
than by convention. The frozen provider surface is unchanged:
`createX402PaymentProvider` and `createPaymentProof`.

## Client-side payment helper
The buyer side of x402 lives in one place so the demo agent and the E2E suite
cannot drift from the gateway's expectations. It is a **client** helper: the
gateway never calls it and never holds a buyer key.

```ts
// src/payments/x402/client.ts
export interface CreatePaymentProofOptions {
  /** Buyer's dev-only private key. LOCAL DEVELOPMENT ONLY — DO NOT FUND. */
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
above exists. `createGateway` must be fully usable — and tested — with fakes,
without `main.ts`.
