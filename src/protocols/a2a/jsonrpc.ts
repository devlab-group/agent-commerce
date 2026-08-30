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

/** JSON-RPC 2.0 reserved codes. */
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

/**
 * A2A's own `UnsupportedOperationError`. Used for a real A2A operation this
 * deployment declines to serve — including an unsupported protocol version —
 * as distinct from `METHOD_NOT_FOUND`, which means the method does not exist.
 */
export const A2A_ERROR_UNSUPPORTED_OPERATION = -32004;

/** An id may legally be a string, a number or null; anything else is not one. */
export type JsonRpcId = string | number | null;

export interface JsonRpcErrorBody {
  readonly code: number;
  readonly message: string;
}

export interface JsonRpcRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params: unknown;
}

export type JsonRpcParseResult =
  | { readonly ok: true; readonly request: JsonRpcRequest }
  | { readonly ok: false; readonly id: JsonRpcId; readonly error: JsonRpcErrorBody };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Echoed back only when the request carried a usable one. */
function readId(value: unknown): JsonRpcId {
  if (typeof value === 'string' || typeof value === 'number') return value;
  return null;
}

export function jsonRpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

export function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function parseJsonRpcRequest(rawBody: string): JsonRpcParseResult {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // The parser's own message names offsets and input fragments; neither is
    // the caller's business, and echoing input is how bodies get reflected.
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
  if (!isPlainObject(payload)) {
    return {
      ok: false,
      id: null,
      error: { code: JSONRPC_INVALID_REQUEST, message: 'Request must be a JSON-RPC 2.0 object.' },
    };
  }

  const id = readId(payload['id']);
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
  if (params !== undefined && !isPlainObject(params)) {
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
