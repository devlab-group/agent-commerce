/**
 * Validators against the pinned `2026-04-17` snapshot.
 *
 * The positive cases are the official examples vendored from the same upstream
 * commit as the schema (`tests/fixtures/acp/2026-04-17/`), so "we accept valid
 * ACP" is checked against ACP's own documents rather than against fixtures we
 * wrote to match our own reading of the spec.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACP_DEFINITIONS,
  type AcpDefinition,
  validateAcpDocument,
} from '../../../src/protocols/acp/validation.js';

const examples = JSON.parse(
  readFileSync('tests/fixtures/acp/2026-04-17/examples.agentic_checkout.json', 'utf8'),
) as Record<string, unknown>;

function example(name: string): unknown {
  const value = examples[name];
  if (value === undefined) throw new Error(`Vendored ACP examples have no "${name}"`);
  return value;
}

/** Structurally cloned so a mutation in one case cannot leak into another. */
function mutated(name: string, mutate: (draft: Record<string, unknown>) => void): unknown {
  const draft = structuredClone(example(name)) as Record<string, unknown>;
  mutate(draft);
  return draft;
}

describe('validateAcpDocument - official examples', () => {
  it.each([
    ['createRequest', 'create_checkout_session_request'],
    ['createRequest', 'create_checkout_session_request_with_first_touch_attribution'],
    ['updateRequest', 'update_checkout_session_request'],
    ['completeRequest', 'complete_checkout_session_request'],
    ['completeRequest', 'complete_checkout_session_request_seller_backed'],
    ['cancelRequest', 'cancel_checkout_session_request'],
    ['checkoutSession', 'create_checkout_session_response'],
    ['checkoutSession', 'update_checkout_session_response'],
    ['checkoutSession', 'get_checkout_session_response'],
    ['checkoutSession', 'cancel_checkout_session_response'],
    ['checkoutSessionWithOrder', 'complete_checkout_session_response'],
    ['discoveryResponse', 'discovery_response_full'],
    ['discoveryResponse', 'discovery_response_minimal'],
    ['error', 'error_400_invalid_item'],
    ['error', 'error_400_idempotency_key_required'],
    ['error', 'error_409_idempotency_in_flight'],
  ])('accepts %s example "%s"', (definition, name) => {
    expect(validateAcpDocument(definition as AcpDefinition, example(name))).toBeUndefined();
  });

  // A `$defs` name that does not exist in the pinned snapshot throws at
  // compile time, so reaching a verdict at all proves every name resolved.
  it('resolves every definition it names against the pinned snapshot', () => {
    for (const definition of Object.keys(ACP_DEFINITIONS) as AcpDefinition[]) {
      expect(validateAcpDocument(definition, null)).toBeDefined();
    }
  });
});

describe('validateAcpDocument - rejections', () => {
  it('rejects a create request missing a required field', () => {
    const failure = validateAcpDocument(
      'createRequest',
      mutated('create_checkout_session_request', (draft) => {
        delete draft['currency'];
      }),
    );
    expect(failure).toEqual({ code: 'required', path: '$.currency' });
  });

  it('rejects a line item with the wrong id type, naming the array index', () => {
    const failure = validateAcpDocument(
      'createRequest',
      mutated('create_checkout_session_request', (draft) => {
        const lineItems = draft['line_items'] as Record<string, unknown>[];
        lineItems[0] = { ...lineItems[0], id: 42 };
      }),
    );
    expect(failure?.code).toBe('type');
    expect(failure?.path).toBe('$.line_items[0].id');
  });

  it('rejects an unknown top-level property', () => {
    const failure = validateAcpDocument(
      'createRequest',
      mutated('create_checkout_session_request', (draft) => {
        draft['payment_data'] = { token: 'tok_123' };
      }),
    );
    expect(failure).toEqual({ code: 'additionalProperties', path: '$.payment_data' });
  });

  it('rejects a malformed money shape in a session response', () => {
    const failure = validateAcpDocument(
      'checkoutSession',
      mutated('create_checkout_session_response', (draft) => {
        const totals = draft['totals'] as Record<string, unknown>[];
        totals[0] = { ...totals[0], amount: '1000' };
      }),
    );
    expect(failure?.code).toBe('type');
    expect(failure?.path).toBe('$.totals[0].amount');
  });

  it('rejects a malformed address in a session response', () => {
    const failure = validateAcpDocument(
      'checkoutSession',
      mutated('get_checkout_session_response', (draft) => {
        const details = draft['fulfillment_details'] as Record<string, unknown>;
        delete (details['address'] as Record<string, unknown>)['country'];
      }),
    );
    expect(failure).toEqual({ code: 'required', path: '$.fulfillment_details.address.country' });
  });

  it('rejects a complete request whose payment data is not an object', () => {
    const failure = validateAcpDocument(
      'completeRequest',
      mutated('complete_checkout_session_request', (draft) => {
        draft['payment_data'] = 'tok_123';
      }),
    );
    expect(failure?.code).toBe('type');
    expect(failure?.path).toBe('$.payment_data');
  });

  it('rejects a completed-session response that carries no order', () => {
    const failure = validateAcpDocument(
      'checkoutSessionWithOrder',
      mutated('complete_checkout_session_response', (draft) => {
        delete draft['order'];
      }),
    );
    expect(failure).toEqual({ code: 'required', path: '$.order' });
  });

  it.each([
    ['a string', 'not-a-session'],
    ['null', null],
    ['an array', []],
  ])('rejects %s as a session, without a path it cannot derive', (_label, value) => {
    const failure = validateAcpDocument('checkoutSession', value);
    expect(failure?.code).toBe('type');
    expect(failure?.path).toBeUndefined();
  });

  // Ajv messages describe our compiled schema; only the failing keyword and a
  // pointer into the caller's own document may cross the adapter boundary.
  it('reports nothing beyond a keyword and a path', () => {
    const failure = validateAcpDocument('createRequest', {});
    expect(Object.keys(failure ?? {}).sort()).toEqual(['code', 'path']);
  });
});
