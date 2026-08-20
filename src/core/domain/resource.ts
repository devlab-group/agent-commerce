/**
 * Canonical resource model.
 *
 * FROZEN CONTRACT.
 */
import type { DecimalAmount, JsonSchema, PaymentMethodName, ProtocolName } from './common.js';

/** HTTP methods a backend handler may use. */
export type BackendMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Describes how the gateway calls the merchant's existing backend.
 *
 * Backend URLs are administrator-controlled configuration only. User- or
 * agent-controlled backend URLs are forbidden (see docs/security.md, SSRF).
 * Secret header values must come from `${ENV_VAR}` placeholders resolved by
 * the config loader, never from plaintext configuration.
 */
export interface BackendHandler {
  readonly type: 'http';
  readonly method: BackendMethod;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Hard upper bound on the backend call. Defaults to DEFAULT_BACKEND_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

/** Default backend timeout when a resource does not specify one. */
export const DEFAULT_BACKEND_TIMEOUT_MS = 10_000;

/**
 * Canonical pricing.
 *
 * `dynamic` exists in the type system for forward compatibility but is
 * REJECTED by config validation in v0.1.0-alpha.
 */
export type Pricing =
  | { readonly type: 'free' }
  | {
      readonly type: 'fixed';
      readonly amount: DecimalAmount;
      readonly currency: string;
    }
  | {
      readonly type: 'dynamic';
      readonly resolver: string;
    };

/**
 * A merchant capability exposed to agents.
 *
 * The canonical resource is the single source of truth: protocol adapters map
 * it outward, they never define their own parallel notion of a resource.
 */
export interface CommerceResource {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly handler: BackendHandler;
  readonly pricing: Pricing;
  readonly exposedVia: readonly ProtocolName[];
  readonly paymentMethods: readonly PaymentMethodName[];
}

/** Read-only view of every configured resource. */
export interface ResourceRegistry {
  get(id: string): CommerceResource | undefined;
  list(): readonly CommerceResource[];
  /** Resources exposed through a given protocol surface. */
  listExposedVia(protocol: ProtocolName): readonly CommerceResource[];
  has(id: string): boolean;
}
