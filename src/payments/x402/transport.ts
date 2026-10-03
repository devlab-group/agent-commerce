/**
 * Build x402 v2 responses for the HTTP route and MCP adapter. This module
 * has no optional peer imports, so both entries can use it.
 */

import type { PaymentResult } from '../../core';
import { isRecord } from '../../core/is-record';

/** MCP `_meta` key of a tool call's `PaymentPayload` (x402 MCP transport) */
export const X402_MCP_PAYMENT_META_KEY = 'x402/payment';

/** MCP `_meta` key of a tool result's settlement response (x402 MCP transport) */
export const X402_MCP_PAYMENT_RESPONSE_META_KEY = 'x402/payment-response';

/**
 * Return the provider's x402 refusal reason when available. For a replay,
 * use the spent-nonce code returned by x402 facilitators.
 */
export function x402ErrorCode(code: string, reason: unknown): string {
  if (code === 'PAYMENT_REPLAYED') return 'invalid_exact_evm_nonce_already_used';
  return typeof reason === 'string' ? reason : 'unexpected_verify_error';
}

interface SettledPayment {
  readonly status: string;
  readonly provider: string;
  readonly currency: string;
  readonly network?: string | undefined;
  readonly externalReference?: string | undefined;
  readonly payer?: string | undefined;
  readonly amountBaseUnits?: string | undefined;
}

// The `SettleResponse` shape. When present, `amount` uses base units.
// `status`, `provider`, `currency`, and `externalReference` are gateway
// extensions; an x402 v2 client ignores fields it does not know.
function settlementDocument(payment: SettledPayment): Record<string, unknown> {
  return {
    success: payment.status === 'settled',
    transaction: payment.externalReference ?? '',
    network: payment.network ?? '',
    ...(payment.payer !== undefined ? { payer: payment.payer } : {}),
    ...(payment.amountBaseUnits !== undefined ? { amount: payment.amountBaseUnits } : {}),
    status: payment.status,
    provider: payment.provider,
    currency: payment.currency,
    ...(payment.externalReference !== undefined
      ? { externalReference: payment.externalReference }
      : {}),
  };
}

/** A delivered payment's settlement response */
export function settlementResponse(payment: PaymentResult): Record<string, unknown> {
  const amountBaseUnits = payment.metadata?.['amountBaseUnits'];
  return settlementDocument({
    ...payment,
    ...(typeof amountBaseUnits === 'string' ? { amountBaseUnits } : {}),
  });
}

/**
 * The settlement response for a backend failure after settlement, from the
 * error's `details.payment`; undefined when the error carries none
 */
export function settlementResponseFromDetails(
  details: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  const payment = details?.['payment'];
  if (!isRecord(payment)) return undefined;
  const text = (key: string): string | undefined =>
    typeof payment[key] === 'string' ? payment[key] : undefined;
  const status = text('status');
  const provider = text('provider');
  const currency = text('currency');
  if (status === undefined || provider === undefined || currency === undefined) return undefined;
  return settlementDocument({
    status,
    provider,
    currency,
    network: text('network'),
    externalReference: text('externalReference'),
    payer: text('payer'),
    amountBaseUnits: text('amountBaseUnits'),
  });
}

/**
 * A refused or unconfirmed settlement as a failed `SettleResponse`. An
 * unconfirmed transfer with a hash uses x402's `settlement_pending` reason.
 */
export function settlementFailure(
  details: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const text = (key: string): string | undefined => {
    const value = details?.[key];
    return typeof value === 'string' ? value : undefined;
  };
  const transaction = text('transactionHash');
  const payer = text('payer');
  let errorReason = text('reason') ?? 'unexpected_settle_error';
  if (details?.['settlementUncertain'] === true) {
    errorReason = transaction !== undefined ? 'settlement_pending' : 'unexpected_settle_error';
  }
  return {
    success: false,
    errorReason,
    transaction: transaction ?? '',
    network: text('network') ?? '',
    ...(payer !== undefined ? { payer } : {}),
  };
}
