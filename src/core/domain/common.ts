/**
 * Shared primitive aliases used across the canonical domain model.
 *
 * FROZEN CONTRACT. Every consumer codes against these shapes; changing one
 * is a breaking change.
 */

/**
 * A JSON Schema document (draft 2020-12 subset in practice).
 *
 * Deliberately loose: protocol adapters translate this to their own schema
 * representation, and the gateway only validates structurally at trust
 * boundaries. Never treat this as trusted input without validation.
 */
export type JsonSchema = Record<string, unknown>;

/**
 * Protocol surfaces a resource can be exposed through in this release.
 *
 * The runtime list is the definition and the type is derived from it, so a
 * caller that has to *check* a name (config validation, the OpenAPI
 * importer's `--expose`) reads the same three strings the type is built from
 * rather than keeping a second copy that can drift.
 */
export type ProtocolName = 'http' | 'mcp' | 'a2a';

/**
 * The same three names as a value, for code that has to *check* one at
 * runtime - config validation, the OpenAPI importer's `--expose`. Typed
 * against `ProtocolName` so an unsupported name cannot enter the list, which
 * is what keeps this from becoming a second definition that drifts.
 */
export const PROTOCOL_NAMES: readonly ProtocolName[] = ['http', 'mcp', 'a2a'];

/** Payment methods a resource can accept in this release. */
export type PaymentMethodName = 'x402';

/** ISO-8601 timestamp string, always UTC with millisecond precision. */
export type IsoTimestamp = string;

/**
 * A decimal amount expressed as a string in the *display* unit of the currency
 * (for example "0.01" USDC), never as a float and never in base units.
 *
 * Conversion to on-chain base units is a payment-provider responsibility.
 */
export type DecimalAmount = string;

/** Health of an individual adapter or subsystem. */
export interface AdapterHealth {
  readonly status: 'pass' | 'warn' | 'fail';
  readonly detail?: string;
  readonly checkedAt: IsoTimestamp;
  readonly durationMs?: number;
}

/**
 * Self-description every adapter must expose so diagnostics can report exactly
 * what is supported instead of implying blanket protocol compatibility.
 *
 *
 */
export interface AdapterDescriptor {
  readonly name: string;
  readonly kind: 'protocol' | 'payment' | 'storage';
  /** Version of this adapter implementation (independent of the spec). */
  readonly implementationVersion: string;
  /** Exact pinned specification revision this adapter targets. */
  readonly supportedSpec: string;
  readonly capabilities: readonly string[];
  readonly status: 'stable' | 'experimental' | 'planned';
  /** Capabilities explicitly NOT implemented, surfaced by `doctor`. */
  readonly unsupported?: readonly string[];
}
