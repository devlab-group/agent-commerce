/**
 * Local mirrors of the gateway's public JSON wire shapes (docs/contracts.md,
 * "Gateway HTTP surface"). This is a browser app with no dependency on
 * `src/core` or `src/gateway` — those are
 * server-side packages, and a frontend consuming an HTTP/JSON API inherently
 * declares its own view of that wire shape. Field names and optionality here
 * are copied verbatim from `src/gateway/public-resource.ts` and
 * `src/gateway/well-known.ts`; keep them in sync if those change.
 */

export type Pricing =
  | { readonly type: 'free' }
  | { readonly type: 'fixed'; readonly amount: string; readonly currency: string }
  | { readonly type: 'dynamic'; readonly resolver: string };

/** `GET /api/resources` entry (src/gateway/public-resource.ts). */
export interface PublicResource {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly method: string;
  readonly pricing: Pricing;
  readonly exposedVia: readonly string[];
  readonly paymentMethods: readonly string[];
}

export interface AdapterHealth {
  readonly status: 'pass' | 'warn' | 'fail';
  readonly detail?: string;
  readonly checkedAt: string;
  readonly durationMs?: number;
}

/** Self-description every adapter/provider/store exposes — never a bare boolean "supported". */
export interface AdapterDescriptor {
  readonly name: string;
  readonly kind: 'protocol' | 'payment' | 'storage';
  readonly implementationVersion: string;
  readonly supportedSpec: string;
  readonly capabilities: readonly string[];
  readonly status: 'stable' | 'experimental' | 'planned';
  /** Capabilities the adapter explicitly does NOT implement — never hide this. */
  readonly unsupported?: readonly string[];
}

export type AdapterWithHealth = AdapterDescriptor & { readonly health: AdapterHealth };

export interface WellKnownX402 {
  readonly enabled: boolean;
  readonly network: string;
  readonly asset: string;
  readonly assetName: string;
  readonly assetVersion: string;
  readonly assetDecimals: number;
  /** Merchant-controlled settlement destination — never a gateway-owned wallet. Public info. */
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  /** No URL: a facilitator endpoint can carry a tenant path or an API key. */
  readonly facilitator: { readonly mode: 'local' | 'remote' };
  /** local | testnet | mainnet — chain id 84532 alone cannot say which. */
  readonly mode: string;
}

/** `GET /.well-known/agent-commerce` (src/gateway/well-known.ts). */
export interface WellKnownDocument {
  readonly gateway: { readonly implementationVersion: string; readonly supportedSpec: string };
  readonly merchant: { readonly id: string; readonly name: string; readonly publicBaseUrl: string };
  readonly protocols: {
    readonly http: { readonly enabled: boolean };
    readonly mcp: { readonly enabled: boolean; readonly mountPath: string };
    // Optional here, not in the gateway config: this mirrors a wire document
    // that an older gateway may not carry.
    readonly a2a?: { readonly enabled: boolean; readonly mountPath: string };
  };
  readonly adapters: readonly AdapterWithHealth[];
  readonly paymentProviders: readonly AdapterDescriptor[];
  readonly store: AdapterDescriptor;
  readonly payments: { readonly x402?: WellKnownX402 };
}

export interface PaymentResult {
  readonly status: 'verified' | 'settled' | 'rejected';
  readonly provider: string;
  readonly externalReference?: string;
  readonly payer?: string;
  readonly payee?: string;
  readonly amount: string;
  readonly currency: string;
  readonly network?: string;
  readonly asset?: string;
  readonly rejectionReason?: string;
  readonly settledAt?: string;
}

/** `GET /api/receipts` entry (core/domain/receipt.ts CommerceReceipt). */
export interface CommerceReceipt {
  readonly id: string;
  readonly requestId: string;
  readonly resourceId: string;
  readonly payment?: PaymentResult;
  readonly deliveredAt: string;
  readonly backendStatus: number;
  readonly durationMs?: number;
  readonly protocol?: string;
  /**
   * Non-secret summary only. `delivered: false` + `backendErrorCode` appear
   * here when settlement succeeded but the backend call then failed — the
   * receipt's own record is truthful about that. A type that does not model
   * the field leaves the dashboard's only merchant-facing view of it
   * rendering a paid-but-undelivered purchase identically to a successful one.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type CommerceEventType =
  | 'resource.discovered'
  | 'resource.requested'
  | 'payment.required'
  | 'payment.rejected'
  | 'payment.verified'
  | 'payment.settled'
  | 'backend.called'
  | 'backend.failed'
  | 'resource.delivered';

/** `GET /api/events` / `GET /api/events/stream` entry (core/domain/event.ts CommerceEvent). */
export interface CommerceEvent {
  readonly id: string;
  readonly type: CommerceEventType;
  readonly requestId: string;
  readonly resourceId?: string;
  readonly at: string;
  readonly adapter?: string;
  readonly paymentProvider?: string;
  readonly durationMs?: number;
  readonly status?: 'ok' | 'error';
}
