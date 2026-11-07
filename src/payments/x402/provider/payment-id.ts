/**
 * Declare x402's `payment-identifier` extension, extract the buyer's retry `id`
 * and validate the echoed `info`. The wire format follows
 * `specs/extensions/payment_identifier.md` at `x402-foundation/x402@6a773dba`.
 * Defining it here avoids a runtime dependency on `@x402/extensions`.
 */
import type { PaymentPayload } from '@x402/core/types';
import type { CommerceResource, PaymentSubmission } from '../../../core';
import { CommerceError } from '../../../core';
import { isRecord } from '../../../core/is-record';
import { decodePaymentSubmission } from '../payload';

/** The extension's key under `PaymentRequired.extensions` and `PaymentPayload.extensions` */
export const PAYMENT_IDENTIFIER = 'payment-identifier';

const ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

/** Declare the extension for a resource with response redelivery configured */
export function paymentIdentifierExtensions(
  resource: CommerceResource,
): Record<string, unknown> | undefined {
  const redelivery = resource.idempotency?.redelivery;
  if (redelivery === undefined) return undefined;
  // A fresh declaration keeps a buyer's in-place ID update from reaching another challenge
  return {
    [PAYMENT_IDENTIFIER]: {
      info: { required: redelivery.required },
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          required: { type: 'boolean' },
          id: { type: 'string', minLength: 16, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' },
        },
        required: ['required'],
      },
    },
  };
}

/**
 * Read and validate the buyer's retry `id` when redelivery is configured.
 * Return no key for undecodable proofs; `verify()` rejects them.
 */
export function paymentRetryKey(context: {
  readonly resource: CommerceResource;
  readonly submission: PaymentSubmission;
}): string | undefined {
  const { resource, submission } = context;
  const redelivery = resource.idempotency?.redelivery;
  if (redelivery === undefined) return undefined;
  const payload = decodePaymentSubmission(submission.payload);
  if (payload === undefined) return undefined;
  const extension = payload.extensions?.[PAYMENT_IDENTIFIER];
  const info = field(extension, 'info');
  if (extension !== undefined && !isRecord(info)) throw invalid(resource);
  const id = field(info, 'id');
  if (id === undefined) {
    if (!redelivery.required) return undefined;
    throw new CommerceError('INPUT_INVALID', 'This resource requires a payment identifier', {
      resourceId: resource.id,
      details: { reason: 'payment_identifier_required' },
    });
  }
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw invalid(resource);
  return id;
}

/**
 * Check that an echoed identifier preserves the challenge's `required` value.
 * Missing echoes pass this check; `paymentRetryKey` enforces required IDs.
 * Additional `info` fields are allowed by x402 v2 §5.1.2.
 */
export function paymentIdentifierEchoed(envelope: unknown, payload: PaymentPayload): boolean {
  const declared = field(field(field(envelope, 'extensions'), PAYMENT_IDENTIFIER), 'info');
  const echoed = payload.extensions?.[PAYMENT_IDENTIFIER];
  if (!isRecord(declared) || echoed === undefined) return true;
  return field(field(echoed, 'info'), 'required') === declared['required'];
}

function invalid(resource: CommerceResource): CommerceError {
  return new CommerceError(
    'INPUT_INVALID',
    'A payment identifier must be 16 to 128 characters of A-Z, a-z, 0-9, "_" and "-"',
    { resourceId: resource.id, details: { reason: 'payment_identifier_invalid' } },
  );
}
