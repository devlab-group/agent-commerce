/**
 * Maps execution-pipeline results and payment-proof input to their MCP wire
 * representation. Uses only the frozen wire helpers from core
 * (`toErrorEnvelope`, `toPaymentRequiredEnvelope`) so the MCP adapter, the
 * HTTP route and the demo buyer agent can never drift apart.
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
} from '../../core/index.js';

function toRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

export function deliveredResult(outcome: DeliveredOutcome): CallToolResult {
  const body = outcome.body;
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? null);
  const isStructured = typeof body === 'object' && body !== null && !Array.isArray(body);
  return {
    content: [{ type: 'text', text }],
    ...(isStructured ? { structuredContent: toRecord(body) } : {}),
    _meta: { [DELIVERY_SUMMARY_META_KEY]: toRecord(toDeliverySummary(outcome)) },
  };
}

export function paymentRequiredResult(outcome: PaymentRequiredOutcome): CallToolResult {
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
