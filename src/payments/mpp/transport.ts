/**
 * Build MPP MCP metadata accepted by the `mppx` client. This module has no
 * optional peer imports, so the `./mcp` subpath can use it.
 */

import { isRecord } from '../../core/is-record';
import { mppProblem } from './problems';

/** MCP `_meta` key of a tool call's credential object */
export const MPP_MCP_CREDENTIAL_META_KEY = 'org.paymentauth/credential';

/** MCP `_meta` key of a tool result's challenges */
export const MPP_MCP_PAYMENT_REQUIRED_META_KEY = 'org.paymentauth/payment-required';

/** MCP `_meta` key of a paid tool result's receipt object */
export const MPP_MCP_RECEIPT_META_KEY = 'org.paymentauth/receipt';

/**
 * Build payment-required metadata from the provider's challenge objects.
 * Return undefined if the envelope has none. The draft uses JSON-RPC error
 * -32042; this gateway puts the data in a tool result's `_meta`, which
 * `mppx` also reads. A refusal adds its Problem Details type.
 */
export function mcpPaymentRequired(
  envelope: unknown,
  refusal?: { readonly code: string; readonly reason?: unknown; readonly detail: string },
): Record<string, unknown> | undefined {
  const challenges = isRecord(envelope) ? envelope['challenges'] : undefined;
  if (!Array.isArray(challenges) || challenges.length === 0) return undefined;
  const reason = typeof refusal?.reason === 'string' ? refusal.reason : undefined;
  return {
    httpStatus: 402,
    challenges,
    ...(refusal !== undefined
      ? {
          problem: {
            ...mppProblem(refusal.code, 402, reason),
            status: 402,
            detail: refusal.detail,
          },
        }
      : {}),
  };
}

/** The receipt object from a serialized `Payment-Receipt` value, base64url JSON */
export function receiptObject(serialized: unknown): Record<string, unknown> | undefined {
  if (typeof serialized !== 'string') return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(serialized, 'base64url').toString('utf8'));
    return isRecord(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}
