/**
 * The gateway's only boundary for calling a merchant backend. An
 * implementation must bound every call with a timeout and must not follow
 * redirects; the built-in HTTP executor does both (docs/security.md).
 */
import type { BackendHandler } from '../domain/resource';

export interface BackendRequest {
  readonly requestId: string;
  readonly resourceId: string;
  /** Validated resource input */
  readonly input: unknown;
  /**
   * Names the operation, so the merchant can recognize a repeat of it. Not
   * `requestId`, which is fresh per call and would make every retry look like
   * new work.
   *
   * An adapter sets it only when the value survives a client retry, a
   * reconnect and a gateway restart. The HTTP executor sends it as the
   * `Idempotency-Key` header, replacing one set in `BackendHandler.headers`;
   * when absent, the executor adds none.
   */
  readonly idempotencyKey?: string;
  /**
   * Adapter-supplied headers for the backend. Configured and executor-set
   * headers take precedence. The HTTP executor filters sensitive and transport
   * headers and rejects invalid names or values with `INPUT_INVALID`.
   */
  readonly backendHeaders?: Readonly<Record<string, string>>;
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
