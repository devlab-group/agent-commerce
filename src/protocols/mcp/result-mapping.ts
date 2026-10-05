/**
 * Maps pipeline outcomes and errors to MCP tool results through the core wire
 * helpers (`toErrorEnvelope`, `toPaymentRequiredEnvelope`,
 * `toDeliverySummary`). The A2A adapter uses all three and the HTTP route the
 * two envelopes, so each shape is defined once.
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  type CommerceError,
  DELIVERY_SUMMARY_META_KEY,
  type DeliveredOutcome,
  type ExecutionOutcome,
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
  X402_MCP_ERROR_META_KEY,
  X402_MCP_PAYMENT_RESPONSE_META_KEY,
  x402ErrorCode,
} from '../../payments/x402/transport';
import { proofCarriers } from './tool-mapping';

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
): Record<string, unknown> {
  return { ...challenge, ...envelope };
}

function paymentRequiredResult(outcome: PaymentRequiredOutcome): CallToolResult {
  const envelope = toPaymentRequiredEnvelope(outcome);
  const p = envelope.payment;
  const x402Required = p.provider === 'x402' ? p.envelope : undefined;
  const structured =
    x402Required !== undefined
      ? withX402Challenge(toRecord(envelope), x402Required)
      : toRecord(envelope);
  const mppRequired = p.provider === 'mpp' ? mcpPaymentRequired(p.envelope) : undefined;
  let meta: Record<string, unknown> | undefined;
  if (x402Required !== undefined) meta = { [X402_MCP_ERROR_META_KEY]: x402Required };
  else if (mppRequired !== undefined) meta = { [MPP_MCP_PAYMENT_REQUIRED_META_KEY]: mppRequired };
  return structuredError(
    structured,
    `Payment required: ${p.amount} ${p.currency} to ${p.destination} for resource "${outcome.resourceId}". Retry with an ${p.provider} payment proof in ${proofCarriers(p.provider)}.`,
    meta,
  );
}

/** A tool result for an error; `rail` is the payment method the call used, if any */
export function errorResult(error: CommerceError, rail?: PaymentMethodName): CallToolResult {
  const envelope = toErrorEnvelope(error);
  const details = error.details;
  const challenge = details?.['challenge'];
  // Include the rail's new challenge when a 402 refusal supplies one
  const refused = error.httpStatus === 402 && isRecord(challenge);
  const x402Required =
    rail === 'x402' && refused
      ? { ...challenge, error: x402ErrorCode(error.code, details?.['reason']) }
      : undefined;
  const structured =
    x402Required !== undefined
      ? withX402Challenge(toRecord(envelope), x402Required)
      : toRecord(envelope);
  let meta: Record<string, unknown> | undefined;
  if (rail === 'x402') {
    const settlement =
      error.code === 'PAYMENT_SETTLEMENT_FAILED'
        ? settlementFailure(details)
        : settlementResponseFromDetails(details);
    if (settlement !== undefined || x402Required !== undefined) {
      meta = {
        ...(x402Required !== undefined ? { [X402_MCP_ERROR_META_KEY]: x402Required } : {}),
        ...(settlement !== undefined ? { [X402_MCP_PAYMENT_RESPONSE_META_KEY]: settlement } : {}),
      };
    }
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
