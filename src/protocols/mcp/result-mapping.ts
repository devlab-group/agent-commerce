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
  type PaymentRequiredOutcome,
  toDeliverySummary,
  toErrorEnvelope,
  toPaymentRequiredEnvelope,
} from '../../core';
import { isRecord } from '../../core/is-record';

function toRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function deliveredResult(outcome: DeliveredOutcome): CallToolResult {
  const body = outcome.body;
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? null);
  return {
    content: [{ type: 'text', text }],
    ...(isRecord(body) ? { structuredContent: body } : {}),
    _meta: { [DELIVERY_SUMMARY_META_KEY]: toRecord(toDeliverySummary(outcome)) },
  };
}

function paymentRequiredResult(outcome: PaymentRequiredOutcome): CallToolResult {
  const envelope = toPaymentRequiredEnvelope(outcome);
  const p = envelope.payment;
  const text = `Payment required: ${p.amount} ${p.currency} to ${p.destination} for resource "${outcome.resourceId}". Retry the call with a ${p.provider} payment proof in the "${PAYMENT_INPUT_FIELD}" input field.`;
  return {
    isError: true,
    content: [{ type: 'text', text }],
    structuredContent: toRecord(envelope),
  };
}

export function errorResult(error: CommerceError): CallToolResult {
  const envelope = toErrorEnvelope(error);
  return {
    isError: true,
    content: [{ type: 'text', text: `${envelope.code}: ${envelope.message}` }],
    structuredContent: toRecord(envelope),
  };
}

export function mapOutcome(outcome: ExecutionOutcome): CallToolResult {
  return outcome.kind === 'delivered' ? deliveredResult(outcome) : paymentRequiredResult(outcome);
}
