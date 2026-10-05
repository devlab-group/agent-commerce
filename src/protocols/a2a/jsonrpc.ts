/**
 * JSON-RPC 2.0 framing for the A2A binding.
 *
 * Transport errors only: this file decides whether a request *is* a valid A2A
 * JSON-RPC call, never what the call means. Commerce outcomes are mapped
 * elsewhere, so a malformed frame and a refused purchase can never be
 * confused for one another.
 *
 * Every JSON-RPC-level failure is returned as a 200 with an `error` member,
 * per the JSON-RPC over HTTP convention A2A clients expect; HTTP status codes
 * are reserved for things that are not JSON-RPC at all (wrong verb, adapter
 * down).
 */
import { isRecord } from '../../core/is-record';

/** JSON-RPC 2.0 reserved codes */
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

/** A2A `TaskNotFoundError` for a task id this stateless adapter cannot find */
export const A2A_ERROR_TASK_NOT_FOUND = -32001;

/** A2A `PushNotificationNotSupportedError` for push configuration methods */
export const A2A_ERROR_PUSH_NOTIFICATION_NOT_SUPPORTED = -32003;

/**
 * A2A `UnsupportedOperationError` for a known operation or message feature
 * this adapter does not serve. Unknown methods use `METHOD_NOT_FOUND`.
 */
export const A2A_ERROR_UNSUPPORTED_OPERATION = -32004;

/** A2A `ContentTypeNotSupportedError` for a non-JSON structured data part */
export const A2A_ERROR_CONTENT_TYPE_NOT_SUPPORTED = -32005;

/** A2A `VersionNotSupportedError` when the requested major.minor is unsupported */
export const A2A_ERROR_VERSION_NOT_SUPPORTED = -32009;

// Use the A2A error name without its `Error` suffix as the ErrorInfo reason.
// Standard JSON-RPC codes carry no A2A error detail.
const A2A_ERROR_REASONS: ReadonlyMap<number, string> = new Map([
  [A2A_ERROR_TASK_NOT_FOUND, 'TASK_NOT_FOUND'],
  [A2A_ERROR_PUSH_NOTIFICATION_NOT_SUPPORTED, 'PUSH_NOTIFICATION_NOT_SUPPORTED'],
  [A2A_ERROR_UNSUPPORTED_OPERATION, 'UNSUPPORTED_OPERATION'],
  [A2A_ERROR_CONTENT_TYPE_NOT_SUPPORTED, 'CONTENT_TYPE_NOT_SUPPORTED'],
  [A2A_ERROR_VERSION_NOT_SUPPORTED, 'VERSION_NOT_SUPPORTED'],
]);

/** An id may legally be a string, a number or null; anything else is not one */
export type JsonRpcId = string | number | null;

export interface JsonRpcErrorBody {
  readonly code: number;
  readonly message: string;
  readonly data?: readonly Record<string, unknown>[];
}

export interface JsonRpcRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params: unknown;
}

export type JsonRpcParseResult =
  | { readonly ok: true; readonly request: JsonRpcRequest }
  | { readonly ok: false; readonly id: JsonRpcId; readonly error: JsonRpcErrorBody };

// Echoed back only when the request carried a usable one
function readId(value: unknown): JsonRpcId {
  if (typeof value === 'string' || typeof value === 'number') return value;
  return null;
}

export function jsonRpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/**
 * Add `google.rpc.ErrorInfo` to the detail array for A2A-specific errors.
 */
export function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
): Record<string, unknown> {
  const reason = A2A_ERROR_REASONS.get(code);
  const error: JsonRpcErrorBody = {
    code,
    message,
    ...(reason !== undefined
      ? {
          data: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason,
              domain: 'a2a-protocol.org',
            },
          ],
        }
      : {}),
  };
  return { jsonrpc: '2.0', id, error };
}

export function parseJsonRpcRequest(rawBody: string): JsonRpcParseResult {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // The parser's own message names offsets and input fragments; neither is
    // the caller's business, and echoing input is how bodies get reflected
    return { ok: false, id: null, error: { code: JSONRPC_PARSE_ERROR, message: 'Invalid JSON.' } };
  }

  if (Array.isArray(payload)) {
    return {
      ok: false,
      id: null,
      error: {
        code: JSONRPC_INVALID_REQUEST,
        message: 'Batch requests are not supported: send a single JSON-RPC request object.',
      },
    };
  }
  if (!isRecord(payload)) {
    return {
      ok: false,
      id: null,
      error: { code: JSONRPC_INVALID_REQUEST, message: 'Request must be a JSON-RPC 2.0 object.' },
    };
  }

  const id = readId(payload['id']);
  // Notifications have no reply. Reject them before they can run or charge.
  if (payload['id'] === undefined) {
    return {
      ok: false,
      id,
      error: {
        code: JSONRPC_INVALID_REQUEST,
        message: 'Request must include an "id"; notifications are unsupported.',
      },
    };
  }
  if (payload['jsonrpc'] !== '2.0') {
    return {
      ok: false,
      id,
      error: { code: JSONRPC_INVALID_REQUEST, message: 'Request must set "jsonrpc" to "2.0".' },
    };
  }
  const method = payload['method'];
  if (typeof method !== 'string' || method.length === 0) {
    return {
      ok: false,
      id,
      error: { code: JSONRPC_INVALID_REQUEST, message: 'Request must carry a "method" string.' },
    };
  }
  const params = payload['params'];
  if (params !== undefined && !isRecord(params)) {
    return {
      ok: false,
      id,
      error: {
        code: JSONRPC_INVALID_PARAMS,
        message: 'Request "params" must be an object.',
      },
    };
  }

  return { ok: true, request: { id, method, params: params ?? {} } };
}
