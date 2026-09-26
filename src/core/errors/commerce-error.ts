// The single error type crossing area boundaries. FROZEN CONTRACT
import { COMMERCE_ERROR_HTTP_STATUS, type CommerceErrorCode, RETRYABLE_ERROR_CODES } from './codes';

export interface CommerceErrorOptions {
  /** Structured, non-secret detail safe to return to a client */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
  readonly requestId?: string;
  readonly resourceId?: string;
  /** Override the default HTTP status for this code */
  readonly httpStatus?: number;
}

/** Serializable wire form of a CommerceError */
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

  /** Non-secret, client-safe representation. `cause` is never included */
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
 * Passes an existing CommerceError through. Other thrown values become a
 * CommerceError with a caller-chosen message, for example
 * `toCommerceError(err, 'BACKEND_ERROR', 'Backend call failed')`.
 *
 * Arbitrary Error messages may contain internal URLs, hostnames or file paths.
 * The original value remains on `cause` for internal logging; `toInfo()` and
 * `toErrorEnvelope()` do not serialize it.
 */
export function toCommerceError(
  value: unknown,
  fallbackCode: CommerceErrorCode = 'INTERNAL_ERROR',
  fallbackMessage = 'Unexpected internal error',
): CommerceError {
  if (isCommerceError(value)) return value;
  return new CommerceError(fallbackCode, fallbackMessage, { cause: value });
}

/** A thrown value reduced to its message and name, for a log line */
export function describeError(error: unknown): { message: string; name?: string } {
  if (error instanceof Error) return { message: error.message, name: error.name };
  return { message: String(error) };
}

/**
 * `Name: message` for a log line, with every URL cut to its scheme and host,
 * because a backend or RPC URL can carry a credential in its userinfo, path or
 * query
 */
export function redactedErrorText(value: unknown): string {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  return text.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, (match) => {
    try {
      const url = new URL(match);
      return `${url.protocol}//${url.host}`;
    } catch {
      return '[unparseable URL]';
    }
  });
}

// Deepest `cause` level toLogInfo() follows, which also ends a cyclic chain
const MAX_LOGGED_CAUSES = 5;

/**
 * An error for an operator log line: the `toInfo()` fields plus the `cause`
 * chain that `toInfo()` leaves out, each level as `redactedErrorText()` gives it
 */
export function toLogInfo(
  value: unknown,
): CommerceErrorInfo & { readonly cause?: readonly string[] } {
  const error = toCommerceError(value);
  const cause: string[] = [];
  let current = error.cause;
  while (current !== undefined && cause.length < MAX_LOGGED_CAUSES) {
    cause.push(redactedErrorText(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return cause.length > 0 ? { ...error.toInfo(), cause } : error.toInfo();
}
