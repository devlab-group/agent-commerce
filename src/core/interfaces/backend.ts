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
  /**
   * Names the *operation*, so the merchant can recognise a repeat of it.
   *
   * Not `requestId`, which is fresh per call and would make every retry look
   * like new work. An adapter sets this only when it can derive a value that
   * survives a client retry, a reconnect and a gateway restart; the HTTP
   * executor forwards it as the `Idempotency-Key` request header. Absent
   * means the protocol has no such notion, and the merchant sees no header.
   */
  readonly idempotencyKey?: string;
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
