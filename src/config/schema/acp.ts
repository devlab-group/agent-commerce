// The ACP checkout adapter's settings and its operation-to-resource mapping
import { CommerceError, type CommerceResource } from '../../core';
import { isRecord } from '../../core/is-record';
import {
  ACP_CHECKOUT_OPERATIONS,
  ACP_OPERATION_INPUT_KEYS,
  ACP_OPERATION_OPTIONAL_INPUT_KEYS,
  ACP_SESSION_ID_INPUT_KEY,
  type AcpCheckoutOperation,
} from '../../protocols/acp/constants';
import type { RawConfig } from './raw';
import type { AcpProtocolConfig } from './types';
import { toBoolean, toNumber } from './values';

// Applied when `protocols.acp` is absent or names no mount
const DEFAULT_ACP_MOUNT_PATH = '/acp';

// Idempotency records must outlive ACP's 24-hour retry window, or a replayed
// key could pass an expired record and run a checkout side effect twice. It is
// both the default and the floor.
const ACP_RETENTION_HOURS = 24;

type RawAcp = NonNullable<RawConfig['protocols']['acp']>;

type EnabledAcpConfig = Extract<AcpProtocolConfig, { enabled: true }>;

function acpInvalid(
  path: string,
  message: string,
  extra: Record<string, unknown> = {},
): CommerceError {
  return new CommerceError('CONFIG_INVALID', message, { details: { path, ...extra } });
}

export function normalizeAcp(raw: RawAcp | undefined): AcpProtocolConfig {
  const mountPath = raw?.mountPath ?? DEFAULT_ACP_MOUNT_PATH;
  if (raw === undefined || !toBoolean(raw.enabled, 'protocols.acp.enabled')) {
    return { enabled: false, mountPath };
  }

  if (raw.auth === undefined) {
    throw acpInvalid(
      'protocols.acp.auth',
      'protocols.acp.auth is required when ACP is enabled - every ACP checkout endpoint is authenticated, and "bearer" is the only scheme supported in this release',
    );
  }
  if (raw.idempotency === undefined) {
    throw acpInvalid(
      'protocols.acp.idempotency',
      'protocols.acp.idempotency is required when ACP is enabled - it names the SQLite file holding checkout idempotency records, and ACP makes the Idempotency-Key mandatory on every checkout POST',
    );
  }

  const discovery = raw.discovery;

  return {
    enabled: true,
    mountPath,
    auth: raw.auth,
    idempotency: {
      path: raw.idempotency.path,
      retentionHours: toNumber(
        raw.idempotency.retentionHours ?? ACP_RETENTION_HOURS,
        'protocols.acp.idempotency.retentionHours',
        { min: ACP_RETENTION_HOURS },
      ),
      merchantIdempotent: raw.idempotency.merchantIdempotent ?? false,
    },
    checkout: { operations: normalizeAcpOperations(raw.checkout) },
    // Built key by key so absent metadata stays absent rather than `undefined`
    ...(discovery !== undefined
      ? {
          discovery: {
            ...(discovery.documentationUrl !== undefined
              ? { documentationUrl: discovery.documentationUrl }
              : {}),
            ...(discovery.supportedCurrencies !== undefined
              ? { supportedCurrencies: discovery.supportedCurrencies }
              : {}),
            ...(discovery.supportedLocales !== undefined
              ? { supportedLocales: discovery.supportedLocales }
              : {}),
            ...(discovery.interventionTypes !== undefined
              ? { interventionTypes: discovery.interventionTypes }
              : {}),
          },
        }
      : {}),
  };
}

// All five operations, each on its own resource. ACP discovery advertises
// `checkout` as one service, so a partial mapping is refused. Operations differ
// in method, input and success status, so one resource cannot serve two.
function normalizeAcpOperations(
  checkout: RawAcp['checkout'],
): Readonly<Record<AcpCheckoutOperation, string>> {
  const configured: Record<string, string> = checkout?.operations ?? {};

  for (const key of Object.keys(configured)) {
    if (!(ACP_CHECKOUT_OPERATIONS as readonly string[]).includes(key)) {
      throw acpInvalid(
        `protocols.acp.checkout.operations.${key}`,
        `protocols.acp.checkout.operations names unknown ACP checkout operation "${key}". Supported: ${ACP_CHECKOUT_OPERATIONS.join(', ')}.`,
      );
    }
  }

  const operations: Record<string, string> = {};
  const claimedBy = new Map<string, AcpCheckoutOperation>();
  for (const operation of ACP_CHECKOUT_OPERATIONS) {
    const path = `protocols.acp.checkout.operations.${operation}`;
    const resourceId = configured[operation];
    if (resourceId === undefined) {
      throw acpInvalid(
        path,
        `${path} is required when ACP is enabled - all five checkout operations must be mapped, since ACP discovery advertises the checkout service as a whole`,
      );
    }
    const claimed = claimedBy.get(resourceId);
    if (claimed !== undefined) {
      throw acpInvalid(
        path,
        `${path} maps resource "${resourceId}", which is already mapped to "${claimed}" - each ACP checkout operation needs its own resource`,
        { resourceId },
      );
    }
    claimedBy.set(resourceId, operation);
    operations[operation] = resourceId;
  }
  return operations as Record<AcpCheckoutOperation, string>;
}

export function validateAcpCheckoutMapping(
  acp: EnabledAcpConfig,
  resources: readonly CommerceResource[],
): void {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));

  for (const operation of ACP_CHECKOUT_OPERATIONS) {
    const resourceId = acp.checkout.operations[operation];
    const path = `protocols.acp.checkout.operations.${operation}`;
    const resource = byId.get(resourceId);
    if (resource === undefined) {
      throw acpInvalid(
        path,
        `${path} maps resource "${resourceId}", which is not defined under "resources"`,
        { resourceId },
      );
    }
    if (!resource.exposedVia.includes('acp')) {
      throw acpInvalid(
        path,
        `Resource "${resourceId}" implements ACP operation "${operation}" but does not list "acp" in its expose - the mapping says which resource serves the operation, expose says ACP may invoke it, and both are required`,
        { resourceId },
      );
    }
    // ACP checkout carries the merchant's own purchase payment (`payment_data`
    // on completion), and ACP has no wire form for our payment-required
    // outcome, so the invocation itself must be free
    if (resource.pricing.type !== 'free' || resource.paymentMethods.length > 0) {
      throw acpInvalid(
        path,
        `Resource "${resourceId}" implements ACP operation "${operation}" and must use pricing.type "free" with no "payments" - ACP checkout carries the merchant's own purchase payment, so the gateway does not also charge for the invocation`,
        { resourceId },
      );
    }
    validateAcpOperationInput(path, operation, resource);
  }
}

// A schema that forbids a key the adapter sends, or requires one it may not
// send, fails requests with INPUT_INVALID. Refused at load instead. An optional
// key counts as sent: a closed cancel schema without `body` would pass a bare
// cancel and refuse every one that carries `intent_trace`. Normalization has
// already closed every object node that omits additionalProperties, so the
// check also looks inside `path` and `body`: a bare `body: { type: object }`
// arrives here accepting no key at all.
function validateAcpOperationInput(
  path: string,
  operation: AcpCheckoutOperation,
  resource: CommerceResource,
): void {
  const schema = resource.inputSchema;
  if (schema === undefined) return;
  const keys: readonly string[] = ACP_OPERATION_INPUT_KEYS[operation];
  const optionalKeys: readonly string[] = ACP_OPERATION_OPTIONAL_INPUT_KEYS[operation] ?? [];
  const sent = [...keys, ...optionalKeys];

  const topLevel = closedObjectProperties(schema);
  if (topLevel !== undefined) {
    for (const key of sent) {
      if (!Object.hasOwn(topLevel, key)) {
        const when = keys.includes(key) ? 'always sends' : 'sends when the caller supplies it';
        throw acpInvalid(
          path,
          `Resource "${resource.id}" implements ACP operation "${operation}" but its input schema sets additionalProperties: false without declaring "${key}", which the adapter ${when} for this operation`,
          { resourceId: resource.id },
        );
      }
    }
  }

  const declared = isRecord(schema['properties']) ? schema['properties'] : {};
  const pathKeys = closedObjectProperties(declared['path']);
  if (
    sent.includes('path') &&
    pathKeys !== undefined &&
    !Object.hasOwn(pathKeys, ACP_SESSION_ID_INPUT_KEY)
  ) {
    throw acpInvalid(
      path,
      `Resource "${resource.id}" implements ACP operation "${operation}" but its "path" schema sets additionalProperties: false without declaring "${ACP_SESSION_ID_INPUT_KEY}", which the adapter always sends inside "path"`,
      { resourceId: resource.id },
    );
  }
  const bodyKeys = closedObjectProperties(declared['body']);
  if (sent.includes('body') && bodyKeys !== undefined && Object.keys(bodyKeys).length === 0) {
    throw acpInvalid(
      path,
      `Resource "${resource.id}" implements ACP operation "${operation}" but its "body" schema accepts no keys, so it refuses every ACP document. Config load closes an object schema that omits additionalProperties: declare body as { type: object, additionalProperties: true }`,
      { resourceId: resource.id },
    );
  }

  const required = schema['required'];
  if (Array.isArray(required)) {
    for (const entry of required) {
      if (typeof entry === 'string' && !keys.includes(entry)) {
        throw acpInvalid(
          path,
          `Resource "${resource.id}" implements ACP operation "${operation}" but its input schema requires "${entry}", which that operation does not always supply (it always sends: ${keys.join(', ')})`,
          { resourceId: resource.id },
        );
      }
    }
  }
}

// The declared properties of a closed object schema, or undefined when the
// schema accepts keys it does not declare
function closedObjectProperties(schema: unknown): Record<string, unknown> | undefined {
  if (!isRecord(schema) || schema['additionalProperties'] !== false) return undefined;
  return isRecord(schema['properties']) ? schema['properties'] : {};
}
