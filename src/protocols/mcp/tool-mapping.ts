/**
 * Maps a canonical `CommerceResource` to an MCP `Tool`.
 *
 * One tool per resource: tool name = resource id, description carries a
 * clear price notice for paid resources, and input schema is the canonical
 * JSON Schema (preserved as-is, including per-property descriptions) with the
 * reserved `_payment` property added for paid resources.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  type CommerceResource,
  PAYMENT_INPUT_FIELD,
  type PaymentMethodName,
} from '../../core/index.js';

/**
 * MCP tool names must match SEP-986: 1-128 chars of [A-Za-z0-9._-].
 *
 * Mirrors the pattern enforced by @modelcontextprotocol/sdk@1.30.0 itself
 * (`dist/esm/shared/toolNameValidation.js`: `TOOL_NAME_REGEX =
 * /^[A-Za-z0-9._-]{1,128}$/`), read from the installed build rather than
 * guessed. We validate independently (instead of importing that internal,
 * unexported module path) so a resource with an illegal id fails loudly here
 * instead of being silently registered and warned about by the SDK.
 */
export const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function isValidToolName(id: string): boolean {
  return MCP_TOOL_NAME_PATTERN.test(id);
}

export function isPaidResource(resource: CommerceResource): boolean {
  return resource.pricing.type !== 'free';
}

/**
 * The rail a resource actually accepts, per its own canonical configuration.
 * Never hard-coded here — the adapter does not decide which payment method a
 * resource uses, it only reflects what the resource declares. `undefined`
 * when the resource lists none (still possible for a priced resource; the
 * pipeline is the one that decides what happens then, not this adapter).
 */
function primaryPaymentMethod(resource: CommerceResource): PaymentMethodName | undefined {
  return resource.paymentMethods[0];
}

/** Human-facing note on how to supply a proof, generic when no rail is configured. */
function paymentProofNote(resource: CommerceResource): string {
  const method = primaryPaymentMethod(resource);
  const rail = method !== undefined ? `a ${method}` : 'a';
  return `Requires ${rail} payment proof in the "${PAYMENT_INPUT_FIELD}" input field (obtained from a previous payment-required response).`;
}

/**
 * Description for the reserved `_payment` input property. Mentions x402's
 * `PAYMENT-SIGNATURE` header convention by name only when the resource
 * actually lists x402 as its method — a different future rail would have a
 * different proof encoding, so that detail must not be asserted for it.
 */
function paymentInputFieldDescription(resource: CommerceResource): string {
  const method = primaryPaymentMethod(resource);
  if (method === 'x402') {
    return 'x402 payment proof (base64 PAYMENT-SIGNATURE value) returned from a previous payment-required response.';
  }
  if (method !== undefined) {
    return `${method} payment proof (base64-encoded) returned from a previous payment-required response.`;
  }
  return 'Payment proof returned from a previous payment-required response.';
}

/**
 * Tool description. For a paid resource this appends a clear, unavoidable
 * price notice so an agent can see the resource costs money before calling
 * it — never buried only in the input schema.
 */
export function buildToolDescription(resource: CommerceResource): string {
  const base = resource.description ?? resource.name;
  switch (resource.pricing.type) {
    case 'free':
      return base;
    case 'fixed': {
      const { amount, currency } = resource.pricing;
      return `${base} Costs ${amount} ${currency} per call. ${paymentProofNote(resource)}`;
    }
    case 'dynamic':
      return `${base} Requires payment (amount determined at request time). ${paymentProofNote(resource)}`;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Builds the MCP `Tool.inputSchema` from the canonical `CommerceResource.inputSchema`.
 *
 * The canonical schema is already JSON Schema, so it is carried through
 * verbatim (properties, descriptions, `required`, and any other JSON Schema
 * keyword) — only `type` is forced to the literal `'object'` MCP requires,
 * and `properties`/`required` are merged rather than replaced. For a paid
 * resource, the reserved optional `_payment` string property is added.
 */
export function buildInputSchema(resource: CommerceResource): Tool['inputSchema'] {
  const base = resource.inputSchema;
  const baseIsObject = isPlainObject(base);

  const basePropertyEntries: readonly [string, object][] =
    baseIsObject && isPlainObject(base.properties)
      ? Object.entries(base.properties).filter((entry): entry is [string, object] =>
          isPlainObject(entry[1]),
        )
      : [];
  const properties: Record<string, object> = Object.fromEntries(basePropertyEntries);

  if (isPaidResource(resource)) {
    // Overwrites any resource-declared `_payment` property. Config is
    // responsible for rejecting that collision at load time — this is not
    // re-checked here.
    properties[PAYMENT_INPUT_FIELD] = {
      type: 'string',
      description: paymentInputFieldDescription(resource),
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
