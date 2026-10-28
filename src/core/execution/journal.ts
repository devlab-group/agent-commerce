// Execution identity and digests for the transaction journal
import { createHash } from 'node:crypto';
import { canonicalJson } from '../canonical-json';
import type { PaymentRequirement, PaymentResult } from '../domain/payment';
import { RECONCILIATION_METADATA_KEY } from '../domain/payment';
import type { CanonicalRequest } from '../domain/request';
import type { CommerceResource } from '../domain/resource';
import type { PersistenceFailure } from '../domain/transaction';
import type { NewTransaction } from '../interfaces/store';
import { isRecord } from '../is-record';
import { SETTLE_AFTER_BACKEND_METADATA_KEY } from './settlement-order';

/** One execute() call */
export interface Flow {
  readonly request: CanonicalRequest;
  readonly transactionId: string;
  /** Labels for failed writes, deduplicated in order of first failure */
  readonly persistenceFailures: PersistenceFailure[];
  /** True when the reserved attempt matches this ID and the store provides recordTransactionStep */
  journaled: boolean;
}

export function createFlow(request: CanonicalRequest, transactionId: string): Flow {
  return { request, transactionId, persistenceFailures: [], journaled: false };
}

/** Snapshot failure labels for events and outcomes, omitting the field when empty */
export function failuresOf(flow: Flow): { persistenceFailures?: readonly PersistenceFailure[] } {
  return flow.persistenceFailures.length > 0
    ? { persistenceFailures: [...flow.persistenceFailures] }
    : {};
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** Hash canonical JSON input, or return undefined when canonicalJson does */
export function inputDigest(input: unknown): string | undefined {
  const json = canonicalJson(input);
  return json !== undefined ? sha256(json) : undefined;
}

/**
 * Hash the resource's pricing, payment methods, authorization requirements and
 * selected payment terms. Exclude handler URLs and headers because they may
 * contain credentials.
 */
export function configDigest(resource: CommerceResource, requirement: PaymentRequirement): string {
  const terms = {
    resourceId: resource.id,
    pricing: resource.pricing,
    paymentMethods: resource.paymentMethods,
    authorization: resource.authorization?.required ?? [],
    requirement: {
      provider: requirement.provider,
      amount: requirement.amount,
      currency: requirement.currency,
      destination: requirement.destination ?? null,
      network: requirement.network ?? null,
      asset: requirement.asset ?? null,
      settleAfterBackend: requirement.metadata?.[SETTLE_AFTER_BACKEND_METADATA_KEY] === true,
    },
  };
  // Fall back to JSON.stringify when terms cannot be canonicalized, such as
  // a configuration string containing a lone surrogate
  return sha256(canonicalJson(terms) ?? JSON.stringify(terms));
}

/** Build journal data for a verified payment's replay reservation */
export function newTransaction(
  flow: Flow,
  resource: CommerceResource,
  requirement: PaymentRequirement,
  verification: PaymentResult,
  validInput: unknown,
  authorization: NewTransaction['authorization'],
): NewTransaction {
  const raw = verification.metadata?.[RECONCILIATION_METADATA_KEY];
  const locator = isRecord(raw) ? raw : undefined;
  const expiresAt = typeof locator?.['expiresAt'] === 'string' ? locator['expiresAt'] : undefined;
  const network = verification.network ?? requirement.network;
  const asset = verification.asset ?? requirement.asset;
  const digest = inputDigest(validInput);
  return {
    id: flow.transactionId,
    protocol: flow.request.protocol,
    ...(network !== undefined ? { network } : {}),
    ...(asset !== undefined ? { asset } : {}),
    ...(locator !== undefined ? { locator } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(authorization !== undefined ? { authorization } : {}),
    ...(digest !== undefined ? { inputDigest: digest } : {}),
    configDigest: configDigest(resource, requirement),
  };
}
