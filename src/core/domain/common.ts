// Shared primitive aliases for the canonical domain model. FROZEN CONTRACT

/**
 * A JSON Schema document (in practice a draft 2020-12 subset). Deliberately
 * loose: adapters translate it to their own schema representation. Never treat
 * it as trusted input without validation.
 */
export type JsonSchema = Record<string, unknown>;

/** Protocol surfaces a resource can be exposed through */
export type ProtocolName = 'http' | 'mcp' | 'a2a' | 'acp';

// A Record over the union fails to compile when a name is missing or extra
const PROTOCOL_NAME_KEYS: Record<ProtocolName, true> = {
  http: true,
  mcp: true,
  a2a: true,
  acp: true,
};

/**
 * The same names as a value, for code that checks one at runtime: config
 * validation and the OpenAPI importer's `--expose`
 */
export const PROTOCOL_NAMES: readonly ProtocolName[] = Object.keys(
  PROTOCOL_NAME_KEYS,
) as ProtocolName[];

/**
 * Payment rails a resource can accept.
 *
 * A resource's list is an ordered candidate list, not a buyer-selected menu.
 * The pipeline uses the first method with an enabled provider, and a
 * rejection ends the request instead of trying another rail. Config requires at
 * least one named rail to be enabled and permits others that are not.
 */
export type PaymentMethodName = 'x402' | 'mpp';

// Checked for completeness the same way as PROTOCOL_NAME_KEYS
const PAYMENT_METHOD_NAME_KEYS: Record<PaymentMethodName, true> = { x402: true, mpp: true };

/** The same names as a value, for config validation */
export const PAYMENT_METHOD_NAMES: readonly PaymentMethodName[] = Object.keys(
  PAYMENT_METHOD_NAME_KEYS,
) as PaymentMethodName[];

/**
 * Authorization methods a resource can require. Neither a transport nor a
 * payment rail: it proves the purchase was approved, and sits beside the
 * payment rather than replacing it.
 */
export type AuthorizationMethodName = 'ap2';

/** ISO-8601 timestamp string, always UTC with millisecond precision */
export type IsoTimestamp = string;

/**
 * A decimal amount as a string in the currency's display unit (for example
 * "0.01" USDC), never a float and never base units. Payment providers convert
 * it to on-chain base units.
 */
export type DecimalAmount = string;

/** Health of an individual adapter or subsystem */
export interface AdapterHealth {
  readonly status: 'pass' | 'warn' | 'fail';
  readonly detail?: string;
  readonly checkedAt: IsoTimestamp;
  readonly durationMs?: number;
}

/** Describes an adapter's supported surface for diagnostics */
export interface AdapterDescriptor {
  readonly name: string;
  readonly kind: 'protocol' | 'payment' | 'storage' | 'authorization';
  /** Version of this adapter implementation, independent of the spec */
  readonly implementationVersion: string;
  /** Exact pinned specification revision this adapter targets */
  readonly supportedSpec: string;
  readonly capabilities: readonly string[];
  readonly status: 'stable' | 'experimental' | 'planned';
  /** Capabilities explicitly not implemented, printed by `doctor` */
  readonly unsupported?: readonly string[];
}
