/**
 * The single error type crossing package boundaries.
 *
 * FROZEN CONTRACT.
 */
import {
  COMMERCE_ERROR_HTTP_STATUS,
  type CommerceErrorCode,
  RETRYABLE_ERROR_CODES,
} from './codes.js';

export interface CommerceErrorOptions {
  /** Structured, non-secret detail safe to return to a client. */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
  readonly requestId?: string;
  readonly resourceId?: string;
  /** Override the default HTTP status for this code. */
  readonly httpStatus?: number;
}

/** Serialisable wire form of a CommerceError. */
export interface CommerceErrorInfo {
  readonly code: CommerceErrorCode;
  readonly message: string;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly resourceId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class CommerceError extends Error {
  readonly code: CommerceErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly requestId?: string;
  readonly resourceId?: string;

  constructor(code: CommerceErrorCode, message: string, options: CommerceErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'CommerceError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? COMMERCE_ERROR_HTTP_STATUS[code];
    this.retryable = RETRYABLE_ERROR_CODES.has(code);
    if (options.details !== undefined) this.details = options.details;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.resourceId !== undefined) this.resourceId = options.resourceId;
    Error.captureStackTrace?.(this, CommerceError);
  }

  /** Non-secret, client-safe representation. */
  toInfo(): CommerceErrorInfo {
    return {
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      retryable: this.retryable,
      ...(this.requestId !== undefined ? { requestId: this.requestId } : {}),
      ...(this.resourceId !== undefined ? { resourceId: this.resourceId } : {}),
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export function isCommerceError(value: unknown): value is CommerceError {
  return value instanceof CommerceError;
}

/**
 * Normalise any thrown value into a CommerceError.
 *
 * Used at package boundaries so an unexpected failure never escapes untyped.
 *
 * SECURITY — do not "improve" this by propagating `value.message`.
 * `CommerceError.message` is client-visible: it is serialised by `toInfo()`
 * and `toErrorEnvelope()` and returned over HTTP and MCP. An arbitrary thrown
 * Error's message routinely carries internal detail — database connection
 * strings, internal hostnames, filesystem paths, backend URLs. Copying it into
 * a client-facing field turns every unexpected exception into an information
 * disclosure.
 *
 * The original value is preserved on `cause`, which is never serialised, so
 * logs and diagnostics keep the full detail while clients get only the
 * caller's deliberate, reviewed `fallbackMessage`.
 *
 * A caller that *wants* a specific client-facing message passes one:
 * toCommerceError(err, 'BACKEND_ERROR', 'Backend call failed')
 */
export function toCommerceError(
  value: unknown,
  fallbackCode: CommerceErrorCode = 'INTERNAL_ERROR',
  fallbackMessage = 'Unexpected internal error',
): CommerceError {
  if (isCommerceError(value)) return value;
  return new CommerceError(fallbackCode, fallbackMessage, { cause: value });
}
