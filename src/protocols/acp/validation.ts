/**
 * Wire validation against the vendored ACP checkout schema.
 *
 * ACP documents need far more of JSON Schema than the subset
 * `src/core/execution` validates canonical input with, so the pinned official
 * schema is compiled with Ajv rather than restated by hand.
 *
 * The schema is imported, not read from disk: bundling collapses `src/**` into
 * a few files under `dist/`, where a relative `readFileSync` resolves from the
 * wrong depth.
 */

import type { ErrorObject, ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { CommerceError } from '../../core';
// The snapshot directory is part of the path on purpose: a new ACP version is
// a new import beside this one, never an edit to the vendored file
import schemaDocument from './spec/2026-04-17/schema.agentic_checkout.json' with { type: 'json' };

/**
 * A validation failure, reduced to what may safely cross the adapter
 * boundary. Ajv messages and schema paths describe *our* compiled schema and
 * never reach a client; the adapter turns this into an ACP `Error`.
 */
export interface AcpValidationFailure {
  /** The JSON Schema keyword that failed: spec vocabulary, not an Ajv internal */
  readonly code: string;
  /** `$.buyer.email`-style pointer to the offending value. Omitted at the document root */
  readonly path?: string;
}

/**
 * The released `$defs` this adapter validates against, keyed by the role it
 * uses them in. Values are the exact snapshot names; all are compiled on first
 * use, which the adapter's start-up discovery check triggers, so a typo fails
 * the adapter at start rather than on a checkout request.
 */
export const ACP_DEFINITIONS = {
  createRequest: 'CheckoutSessionCreateRequest',
  updateRequest: 'CheckoutSessionUpdateRequest',
  completeRequest: 'CheckoutSessionCompleteRequest',
  cancelRequest: 'CancelSessionRequest',
  checkoutSession: 'CheckoutSession',
  checkoutSessionWithOrder: 'CheckoutSessionWithOrder',
  discoveryResponse: 'DiscoveryResponse',
  error: 'Error',
} as const;

export type AcpDefinition = keyof typeof ACP_DEFINITIONS;

let validators: ReadonlyMap<AcpDefinition, ValidateFunction> | undefined;

// Compiled once per process, on first use rather than at import, so a gateway
// with ACP disabled never pays for it
function acpValidators(): ReadonlyMap<AcpDefinition, ValidateFunction> {
  if (validators !== undefined) return validators;

  const ajv = new Ajv2020({
    // The vendored document is the released spec; unknown annotations in it
    // are no reason to refuse to start
    strict: false,
    // Only one failure leaves the adapter, and collecting every error in a
    // deeply nested cart is work a caller could request repeatedly
    allErrors: false,
  });
  addFormats(ajv);

  const document = relaxExtensibleEnums(structuredClone(schemaDocument)) as Record<string, unknown>;
  openCapabilityValues(document);
  const schemaId = typeof document['$id'] === 'string' ? document['$id'] : '';
  ajv.addSchema(document as Parameters<typeof ajv.addSchema>[0]);

  const compiled = new Map<AcpDefinition, ValidateFunction>();
  for (const [name, definition] of Object.entries(ACP_DEFINITIONS)) {
    const validate = ajv.getSchema(`${schemaId}#/$defs/${definition}`);
    if (validate === undefined) {
      throw new CommerceError(
        'PROTOCOL_UNSUPPORTED',
        `The vendored ACP schema has no definition "${definition}" - the pinned snapshot and this adapter disagree`,
        { details: { definition } },
      );
    }
    compiled.set(name as AcpDefinition, validate);
  }

  validators = compiled;
  return compiled;
}

/**
 * Drops the `enum` constraint from the fields whose description says the enum
 * is extensible ("servers SHOULD accept unrecognized values and treat them as
 * 'other'"). Enums ACP calls closed per API version stay closed; this only
 * avoids refusing, say, a cancel over a reason code the buyer's agent knows
 * and this snapshot does not.
 */
function relaxExtensibleEnums(node: unknown): unknown {
  if (Array.isArray(node)) {
    for (const entry of node) relaxExtensibleEnums(entry);
    return node;
  }
  if (node === null || typeof node !== 'object') return node;

  const record = node as Record<string, unknown>;
  const description = record['description'];
  if (
    Array.isArray(record['enum']) &&
    typeof description === 'string' &&
    /enum is extensible/i.test(description)
  ) {
    delete record['enum'];
  }
  for (const value of Object.values(record)) relaxExtensibleEnums(value);
  return node;
}

/**
 * Allow unknown intervention values in negotiated `supported` and `required`
 * lists, as ACP requires. The snapshot schema closes these enums; other
 * fields remain strict.
 */
function openCapabilityValues(document: Record<string, unknown>): void {
  const defs = document['$defs'] as Record<string, { properties?: Record<string, unknown> }>;
  const properties = defs['InterventionCapabilities']?.properties ?? {};
  for (const list of ['supported', 'required']) {
    const items = (properties[list] as { items?: Record<string, unknown> } | undefined)?.items;
    if (items !== undefined) delete items['enum'];
  }
}

/**
 * Validates one ACP document against a released definition: `undefined` when
 * it conforms, otherwise the first failure. Inbound, a failure is a 400 and no
 * pipeline call; outbound, the merchant's body is not ACP and is not forwarded.
 */
export function validateAcpDocument(
  definition: AcpDefinition,
  value: unknown,
): AcpValidationFailure | undefined {
  const validate = acpValidators().get(definition);
  /* c8 ignore next -- unreachable: every AcpDefinition is compiled above */
  if (validate === undefined) return { code: 'unknown_definition' };

  if (validate(value)) return undefined;
  const error = validate.errors?.[0];
  if (error === undefined) return { code: 'invalid' };

  const path = failurePath(error);
  return { code: error.keyword, ...(path !== undefined ? { path } : {}) };
}

/**
 * Ajv's JSON Pointer, rewritten in the `$.a.b[0]` form ACP errors use in `param`.
 * `required` and `additionalProperties` failures point at the parent object,
 * so the offending key is appended: `$.buyer.email` rather than `$.buyer`.
 */
function failurePath(error: ErrorObject): string | undefined {
  const segments = error.instancePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));

  const params = error.params as { missingProperty?: unknown; additionalProperty?: unknown };
  const key = params.missingProperty ?? params.additionalProperty;
  if (typeof key === 'string') segments.push(key);

  if (segments.length === 0) return undefined;
  return segments.reduce(
    (path, segment) => (/^\d+$/.test(segment) ? `${path}[${segment}]` : `${path}.${segment}`),
    '$',
  );
}
