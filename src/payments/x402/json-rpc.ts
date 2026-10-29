import { CommerceError } from '../../core';

/**
 * Sends a Solana or NEAR JSON-RPC request with the caller's timeout.
 * Node-reported JSON-RPC errors throw `PAYMENT_PROVIDER_UNAVAILABLE`, with the
 * error object in `details.rpcError`.
 */
export async function jsonRpc(
  rpcUrl: string,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined) {
    throw new CommerceError(
      'PAYMENT_PROVIDER_UNAVAILABLE',
      `RPC ${method} failed: ${JSON.stringify(body.error)}`,
      { details: { rpcError: body.error } },
    );
  }
  return body.result;
}
