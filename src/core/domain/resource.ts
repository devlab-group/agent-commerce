// Canonical resource model. FROZEN CONTRACT
import type {
  AuthorizationMethodName,
  DecimalAmount,
  JsonSchema,
  PaymentMethodName,
  ProtocolName,
} from './common';

/** HTTP methods a backend handler may use */
export type BackendMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * How the gateway calls the merchant's existing backend.
 *
 * Backend URLs come from operator configuration only, never from users or
 * agents (docs/security.md, SSRF). Secret header values belong in `${ENV_VAR}`
 * placeholders resolved by the config loader, not in plaintext configuration.
 */
export interface BackendHandler {
  readonly type: 'http';
  readonly method: BackendMethod;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Hard upper bound on the backend call. Defaults to `DEFAULT_BACKEND_TIMEOUT_MS` */
  readonly timeoutMs?: number;
  /**
   * Names the top-level input properties carrying each part of the request.
   *
   * When absent, `{param}` values come from top-level input and everything left
   * over becomes the query string (GET/DELETE) or the whole JSON body
   * (POST/PUT/PATCH). That cannot express an operation with path, query and
   * body at once, such as `POST /users/{userId}/orders?notify=true`.
   *
   * When present, each group comes from its named property, and top-level input
   * that no binding names is not forwarded.
   */
  readonly inputBindings?: {
    readonly path?: string;
    readonly query?: string;
    readonly body?: string;
  };
}

/** Default backend timeout when a resource does not specify one */
export const DEFAULT_BACKEND_TIMEOUT_MS = 10_000;

/**
 * Canonical pricing. `dynamic` exists in the type for forward compatibility;
 * config validation rejects it and the pipeline refuses it as defense in depth.
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
 * A merchant capability exposed to agents. Protocol adapters map it outward and
 * never define their own parallel notion of a resource.
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
  /**
   * Authorization the buyer must present in addition to payment. Opt-in per
   * resource. It sits beside `paymentMethods`, not inside it, because an
   * authorization method is not a payment rail and must never be selectable as
   * one.
   */
  readonly authorization?: {
    readonly required: readonly AuthorizationMethodName[];
  };
}

/** Read-only view of every configured resource */
export interface ResourceRegistry {
  get(id: string): CommerceResource | undefined;
  list(): readonly CommerceResource[];
  /** Resources exposed through a given protocol surface */
  listExposedVia(protocol: ProtocolName): readonly CommerceResource[];
  has(id: string): boolean;
}
