/**
 * The ACP `Error` object and the one writer every ACP response goes through,
 * so no handler invents its own error shape. Every error message is written by
 * the gateway: no stack, backend body, Ajv message, token or internal path
 * reaches a client.
 */
import type { ServerResponse } from 'node:http';
import { ACP_JSON_MEDIA_TYPE } from './constants';

/** The three categories the pinned snapshot allows */
export type AcpErrorType = 'invalid_request' | 'processing_error' | 'service_unavailable';

export interface AcpError {
  readonly type: AcpErrorType;
  readonly code: string;
  readonly message: string;
  /** RFC 9535 JSONPath into the caller's document, never into ours */
  readonly param?: string;
  /** Only on version errors, per the snapshot */
  readonly supported_versions?: readonly string[];
}

/** An ACP error plus the status it is served with */
export interface AcpFailure {
  readonly status: number;
  readonly error: AcpError;
  /** Seconds for `Retry-After`, where the failure invites a retry */
  readonly retryAfterSeconds?: number;
}

export function acpFailure(
  status: number,
  type: AcpErrorType,
  code: string,
  message: string,
  extra: { readonly param?: string; readonly supportedVersions?: readonly string[] } = {},
): AcpFailure {
  return {
    status,
    error: {
      type,
      code,
      message,
      ...(extra.param !== undefined ? { param: extra.param } : {}),
      ...(extra.supportedVersions !== undefined
        ? { supported_versions: extra.supportedVersions }
        : {}),
    },
  };
}

/**
 * Response headers the adapter may set. Merchant backend headers are never
 * proxied: a backend's `Set-Cookie` or tracing header belongs to the
 * merchant's domain, not to the ACP client. `Retry-After` is rebuilt from a
 * parsed and capped number, not copied.
 */
export type AcpResponseHeaders = Readonly<Record<string, string>>;

export function writeAcpJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: AcpResponseHeaders = {},
): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': ACP_JSON_MEDIA_TYPE, ...headers });
  res.end(JSON.stringify(body));
}

export function writeAcpFailure(
  res: ServerResponse,
  failure: AcpFailure,
  headers: AcpResponseHeaders = {},
): void {
  writeAcpJson(res, failure.status, failure.error, headers);
}
