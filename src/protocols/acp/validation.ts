/**
 * Wire validation against the vendored ACP checkout schema.
 *
 * ACP request and response bodies are far larger than the JSON-Schema subset
 * `src/core/execution` validates canonical input with, so the pinned official
 * schema is compiled with Ajv rather than restated by hand: a hand-written
 * copy is a second definition of the protocol, and it drifts.
 *
 * The schema is *imported*, not read from disk. `dist/` collapses `src/**`
 * into two bundled files, so a relative `readFileSync` resolves from the wrong
 * depth once built - a failure this repository has shipped twice.
 */

import type { ErrorObject, ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { CommerceError } from '../../core/index.js';
// The snapshot directory is part of the path on purpose: a new ACP version is
// a new import beside this one, never an edit to the vendored file.
import schemaDocument from './spec/2026-04-17/schema.agentic_checkout.json' with { type: 'json' };

/**
 * A validation failure, reduced to what may safely cross the adapter
 * boundary. Ajv messages and schema paths describe *our* compiled schema and
 * never reach a client; the adapter turns this into an ACP `Error`.
 */
export interface AcpValidationFailure {
  /** The JSON Schema keyword that failed - spec vocabulary, not an Ajv internal. */
  readonly code: string;
  /** `$.buyer.email`-style pointer to the offending value. Omitted at the document root. */
  readonly path?: string;
}

/**
 * The released `$defs` this adapter validates against, by the role it uses
 * them in. Keys are ours; values are the exact names in the released snapshot,
 * and a typo in one is caught at first use rather than at first request.
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

/**
 * Compiled once for the process, on first use rather than at import: a gateway
 * with ACP disabled never pays for it, and the cost is the same either way for
 * one that has it on.
 */
function acpValidators(): ReadonlyMap<AcpDefinition, ValidateFunction> {
  if (validators !== undefined) return validators;

  const ajv = new Ajv2020({
    // The vendored document is the released spec: annotations we do not know
    // are the spec's business, not a reason to refuse to start.
    strict: false,
    // One failure is all that leaves the adapter, and collecting every error
    // in a deeply nested cart is work an unauthenticated caller could ask for
    // repeatedly.
    allErrors: false,
  });
  addFormats(ajv);

  const document = schemaDocument as unknown as { readonly $id?: unknown };
  const schemaId = typeof document.$id === 'string' ? document.$id : '';
  ajv.addSchema(schemaDocument);

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
 * Validates one ACP document against a released definition.
 *
 * Returns `undefined` when the value conforms, otherwise the first failure.
 * Inbound, that failure becomes a 400 and no pipeline call happens; outbound,
 * it means the merchant backend returned something that is not ACP, and the
 * body must not be forwarded.
 */
export function validateAcpDocument(
  definition: AcpDefinition,
  value: unknown,
): AcpValidationFailure | undefined {
  const validate = acpValidators().get(definition);
  /* c8 ignore next -- unreachable: every AcpDefinition is compiled above. */
  if (validate === undefined) return { code: 'unknown_definition' };

  if (validate(value)) return undefined;
  const error = validate.errors?.[0];
  if (error === undefined) return { code: 'invalid' };

  const path = failurePath(error);
  return { code: error.keyword, ...(path !== undefined ? { path } : {}) };
}

/**
 * Ajv's JSON Pointer, rendered as the `$.a.b[0]` form ACP errors use in
 * `param`. `required` and `additionalProperties` failures report the parent
 * object, so the offending key is appended - the difference between telling a
 * client `$` and telling it `$.buyer.email`.
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
