/**
 * Merchant backend execution boundary.
 *
 * The only place in the system allowed to make an outbound HTTP call to a
 * merchant backend. Every call is bounded by a timeout; redirects are not
 * followed (see docs/security.md).
 */
import type { BackendHandler } from '../domain/resource.js';

export interface BackendRequest {
  readonly requestId: string;
  readonly resourceId: string;
  /** Validated resource input. */
  readonly input: unknown;
}

export interface BackendResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly durationMs: number;
}

export interface BackendExecutor {
  /**
   * Call the merchant backend.
   *
   * Must throw `CommerceError('BACKEND_TIMEOUT')` on timeout and
   * `CommerceError('BACKEND_ERROR')` for non-2xx responses and transport
   * failures. Must never throw an untyped error.
   */
  call(handler: BackendHandler, request: BackendRequest): Promise<BackendResponse>;
}
