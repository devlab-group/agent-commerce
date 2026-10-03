/**
 * Maps pipeline outcomes and errors to MCP tool results through the core wire
 * helpers (`toErrorEnvelope`, `toPaymentRequiredEnvelope`,
 * `toDeliverySummary`). The A2A adapter uses all three and the HTTP route the
 * two envelopes, so each shape is defined once.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  type CommerceError,
  DELIVERY_SUMMARY_META_KEY,
  type DeliveredOutcome,
  type ExecutionOutcome,
  PAYMENT_INPUT_FIELD,
  type PaymentMethodName,
  type PaymentRequiredOutcome,
  toDeliverySummary,
  toErrorEnvelope,
  toPaymentRequiredEnvelope,
} from '../../core';
import { isRecord } from '../../core/is-record';
import {
  MPP_MCP_PAYMENT_REQUIRED_META_KEY,
  MPP_MCP_RECEIPT_META_KEY,
  mcpPaymentRequired,
  receiptObject,
} from '../../payments/mpp/transport';
import {
  settlementFailure,
  settlementResponse,
  settlementResponseFromDetails,
  X402_MCP_PAYMENT_RESPONSE_META_KEY,
  x402ErrorCode,
} from '../../payments/x402/transport';

function toRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function deliveredResult(outcome: DeliveredOutcome): CallToolResult {
  const body = outcome.body;
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? null);
  const payment = outcome.payment;
  const receipt =
    payment?.provider === 'mpp' ? receiptObject(payment.metadata?.['receipt']) : undefined;
  return {
    content: [{ type: 'text', text }],
    ...(isRecord(body) ? { structuredContent: body } : {}),
    _meta: {
      [DELIVERY_SUMMARY_META_KEY]: toRecord(toDeliverySummary(outcome)),
      ...(payment?.provider === 'x402'
        ? { [X402_MCP_PAYMENT_RESPONSE_META_KEY]: settlementResponse(payment) }
        : {}),
      ...(receipt !== undefined ? { [MPP_MCP_RECEIPT_META_KEY]: receipt } : {}),
    },
  };
}

// The x402 MCP transport requires the first text block to repeat
// `structuredContent` as JSON; the second gives readers a short explanation
function structuredError(
  structured: Record<string, unknown>,
  sentence: string,
  meta?: Record<string, unknown>,
): CallToolResult {
  return {
    isError: true,
    content: [
      { type: 'text', text: JSON.stringify(structured) },
      { type: 'text', text: sentence },
    ],
    structuredContent: structured,
    ...(meta !== undefined ? { _meta: meta } : {}),
  };
}

// Put x402's PaymentRequired fields beside the gateway error envelope so
// x402 clients can read the challenge from `structuredContent`
function withX402Challenge(
  envelope: Record<string, unknown>,
  challenge: Record<string, unknown>,
  error?: string,
): Record<string, unknown> {
  return { ...challenge, ...(error !== undefined ? { error } : {}), ...envelope };
}

function paymentRequiredResult(outcome: PaymentRequiredOutcome): CallToolResult {
  const envelope = toPaymentRequiredEnvelope(outcome);
  const p = envelope.payment;
  const structured =
    p.provider === 'x402' && p.envelope !== undefined
      ? withX402Challenge(toRecord(envelope), p.envelope)
      : toRecord(envelope);
  const mppRequired = p.provider === 'mpp' ? mcpPaymentRequired(p.envelope) : undefined;
  return structuredError(
    structured,
    `Payment required: ${p.amount} ${p.currency} to ${p.destination} for resource "${outcome.resourceId}". Retry the call with a ${p.provider} payment proof in the "${PAYMENT_INPUT_FIELD}" input field.`,
    mppRequired !== undefined ? { [MPP_MCP_PAYMENT_REQUIRED_META_KEY]: mppRequired } : undefined,
  );
}

/** A tool result for an error; `rail` is the payment method the call used, if any */
export function errorResult(error: CommerceError, rail?: PaymentMethodName): CallToolResult {
  const envelope = toErrorEnvelope(error);
  const details = error.details;
  const challenge = details?.['challenge'];
  // Include the rail's new challenge when a 402 refusal supplies one
  const refused = error.httpStatus === 402 && isRecord(challenge);
  const structured =
    rail === 'x402' && refused
      ? withX402Challenge(
          toRecord(envelope),
          challenge,
          x402ErrorCode(error.code, details?.['reason']),
        )
      : toRecord(envelope);
  let meta: Record<string, unknown> | undefined;
  if (rail === 'x402') {
    const settlement =
      error.code === 'PAYMENT_SETTLEMENT_FAILED'
        ? settlementFailure(details)
        : settlementResponseFromDetails(details);
    if (settlement !== undefined) meta = { [X402_MCP_PAYMENT_RESPONSE_META_KEY]: settlement };
  } else if (rail === 'mpp' && refused) {
    // MPP error results carry a challenge but no receipt
    const required = mcpPaymentRequired(challenge, {
      code: error.code,
      reason: details?.['reason'],
      detail: error.message,
    });
    if (required !== undefined) meta = { [MPP_MCP_PAYMENT_REQUIRED_META_KEY]: required };
  }
  return structuredError(structured, `${envelope.code}: ${envelope.message}`, meta);
}

export function mapOutcome(outcome: ExecutionOutcome): CallToolResult {
  return outcome.kind === 'delivered' ? deliveredResult(outcome) : paymentRequiredResult(outcome);
}
