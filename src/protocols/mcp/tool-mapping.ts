/**
 * Maps a canonical `CommerceResource` to an MCP `Tool`: the tool name is the
 * resource id, the description carries a price notice for a paid resource,
 * and the input schema is the canonical JSON Schema plus the reserved
 * `_payment` and `_authorization` properties the resource accepts
 */

import type { JSONObject, Tool } from '@modelcontextprotocol/server';
import {
  AUTHORIZATION_INPUT_FIELD,
  type CommerceResource,
  PAYMENT_INPUT_FIELD,
  type PaymentMethodName,
} from '../../core';
import { isRecord } from '../../core/is-record';
import { MPP_MCP_CREDENTIAL_META_KEY } from '../../payments/mpp/transport';
import { X402_MCP_PAYMENT_META_KEY } from '../../payments/x402/transport';
import { MCP_TOOL_NAME_PATTERN } from './constants';

export function isValidToolName(id: string): boolean {
  return MCP_TOOL_NAME_PATTERN.test(id);
}

function isPaidResource(resource: CommerceResource): boolean {
  return resource.pricing.type !== 'free';
}

// The rail a `_payment` proof is labeled with (see `extractReservedInputFields`),
// `undefined` when the resource lists none
function primaryPaymentMethod(resource: CommerceResource): PaymentMethodName | undefined {
  return resource.paymentMethods[0];
}

/** Describe the selected rail's `_meta` proof and `_payment` fallback */
export function proofCarriers(method: PaymentMethodName | undefined): string {
  const field = `the "${PAYMENT_INPUT_FIELD}" argument`;
  if (method === 'x402') return `_meta["${X402_MCP_PAYMENT_META_KEY}"] or ${field}`;
  if (method === 'mpp') return `_meta["${MPP_MCP_CREDENTIAL_META_KEY}"] or ${field}`;
  return field;
}

// How to supply a proof, generic when the resource names no rail
function paymentProofNote(resource: CommerceResource): string {
  const method = primaryPaymentMethod(resource);
  const rail = method !== undefined ? `an ${method}` : 'a';
  return `Requires ${rail} payment proof in ${proofCarriers(method)}, built from the payment-required response.`;
}

// Tell callers to omit `_payment` when a wrapper supplies `_meta`
const OMIT_NOTE = 'Omit it when the client sends the proof in _meta.';

/**
 * Description for the reserved `_payment` input property, in the proof
 * encoding of the resource's own rail
 */
function paymentInputFieldDescription(resource: CommerceResource): string {
  const method = primaryPaymentMethod(resource);
  if (method === 'x402') {
    return `x402 payment proof (base64 PAYMENT-SIGNATURE value) for a previous payment-required response. ${OMIT_NOTE}`;
  }
  if (method === 'mpp') {
    return `MPP credential (the full "Authorization: Payment ..." value) for the challenge in a previous payment-required response. ${OMIT_NOTE}`;
  }
  if (method !== undefined) {
    return `${method} payment proof (base64-encoded) returned from a previous payment-required response.`;
  }
  return 'Payment proof returned from a previous payment-required response.';
}

// The authorization methods the resource requires, empty when it requires none
function requiredAuthorization(resource: CommerceResource): readonly string[] {
  return resource.authorization?.required ?? [];
}

function authorizationNote(resource: CommerceResource): string {
  const methods = requiredAuthorization(resource);
  return methods.length > 0
    ? ` Also requires ${methods.join(' and ')} authorization in the "${AUTHORIZATION_INPUT_FIELD}" input field.`
    : '';
}

/**
 * Tool description. A paid resource gets a price notice appended, so an agent
 * sees the cost before calling, not only in the input schema.
 */
export function buildToolDescription(resource: CommerceResource): string {
  const base = resource.description ?? resource.name;
  switch (resource.pricing.type) {
    case 'free':
      return base;
    case 'fixed': {
      const { amount, currency } = resource.pricing;
      return `${base} Costs ${amount} ${currency} per call. ${paymentProofNote(resource)}${authorizationNote(resource)}`;
    }
    case 'dynamic':
      return `${base} Requires payment (amount determined at request time). ${paymentProofNote(resource)}${authorizationNote(resource)}`;
  }
}

/**
 * Builds the MCP `Tool.inputSchema` from the canonical `CommerceResource.inputSchema`.
 *
 * Every keyword is carried through except that `type` is forced to the
 * `'object'` MCP requires, `properties` keeps only object-valued entries and
 * `required` only strings. A paid resource gains the optional `_payment`
 * string property, and a resource requiring authorization the optional
 * `_authorization` object. Both are declared because a resource's input schema
 * is closed by default, and a client that validates arguments against it
 * would otherwise refuse to send them.
 */
export function buildInputSchema(resource: CommerceResource): Tool['inputSchema'] {
  const base = resource.inputSchema;
  const baseIsObject = isRecord(base);

  // Keep object-valued property schemas from the resource's config JSON
  const basePropertyEntries: readonly [string, JSONObject][] =
    baseIsObject && isRecord(base.properties)
      ? Object.entries(base.properties).filter((entry): entry is [string, JSONObject] =>
          isRecord(entry[1]),
        )
      : [];
  const properties: Record<string, JSONObject> = Object.fromEntries(basePropertyEntries);

  // Both overwrite a resource-declared property of the same name; config
  // rejects that collision at load time
  if (isPaidResource(resource)) {
    properties[PAYMENT_INPUT_FIELD] = {
      type: 'string',
      description: paymentInputFieldDescription(resource),
    };
  }
  const methods = requiredAuthorization(resource);
  if (methods.length > 0) {
    properties[AUTHORIZATION_INPUT_FIELD] = {
      type: 'object',
      description:
        'Authorization this resource requires in addition to payment: the method and its serialized proof.',
      properties: {
        method: { type: 'string', enum: [...methods] },
        payload: { type: 'string', minLength: 1 },
      },
      required: ['method', 'payload'],
    };
  }

  const required =
    baseIsObject && Array.isArray(base.required)
      ? base.required.filter((v): v is string => typeof v === 'string')
      : [];

  const extra = baseIsObject
    ? Object.fromEntries(
        Object.entries(base).filter(
          ([key]) => key !== 'type' && key !== 'properties' && key !== 'required',
        ),
      )
    : {};

  return {
    ...extra,
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}
