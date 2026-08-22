/**
 * ============================================================================
 * FROZEN PUBLIC CONTRACT — v0.1.0-alpha
 * ============================================================================
 *
 * Every cross-package type and interface in the project is re-exported here.
 * This barrel is frozen. Everything reachable from it is public API that
 * consumers code against, so a change to any of it is a breaking change and
 * needs the decision record updated to match.
 *
 * Do not redeclare these shapes locally. If something is missing, add it here
 * rather than creating a parallel type.
 *
 * See docs/contracts.md for the freeze record.
 */

// --- canonical domain ------------------------------------------------------
export type {
  AdapterDescriptor,
  AdapterHealth,
  DecimalAmount,
  IsoTimestamp,
  JsonSchema,
  PaymentMethodName,
  ProtocolName,
} from './domain/common.js';
export type { CommerceEvent, CommerceEventType, EventSink } from './domain/event.js';
export { COMMERCE_EVENT_TYPES } from './domain/event.js';

export type {
  PaymentChallenge,
  PaymentContext,
  PaymentProvider,
  PaymentRequirement,
  PaymentResult,
  PaymentSettlementContext,
  PaymentSubmission,
  PaymentVerificationContext,
} from './domain/payment.js';

export type { CommerceReceipt, PaymentAttempt } from './domain/receipt.js';
export type {
  CanonicalRequest,
  DeliveredOutcome,
  ExecutionOutcome,
  ExecutionPipeline,
  PaymentRequiredOutcome,
} from './domain/request.js';
export type {
  BackendHandler,
  BackendMethod,
  CommerceResource,
  Pricing,
  ResourceRegistry,
} from './domain/resource.js';
export { DEFAULT_BACKEND_TIMEOUT_MS } from './domain/resource.js';
export type {
  DeliverySummary,
  ErrorEnvelope,
  PaymentRequiredEnvelope,
} from './domain/wire.js';
export {
  DELIVERY_SUMMARY_META_KEY,
  isPaymentRequiredEnvelope,
  PAYMENT_HEADER,
  PAYMENT_INPUT_FIELD,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  toDeliverySummary,
  toErrorEnvelope,
  toPaymentRequiredEnvelope,
} from './domain/wire.js';

// --- errors ----------------------------------------------------------------
export type { CommerceErrorCode, CommerceErrorInfo, CommerceErrorOptions } from './errors/index.js';
export {
  COMMERCE_ERROR_CODES,
  COMMERCE_ERROR_HTTP_STATUS,
  CommerceError,
  isCommerceError,
  RETRYABLE_ERROR_CODES,
  toCommerceError,
} from './errors/index.js';

// --- injection boundaries --------------------------------------------------
export type { BackendExecutor, BackendRequest, BackendResponse } from './interfaces/backend.js';
export type { Logger } from './interfaces/logger.js';
export { NOOP_LOGGER } from './interfaces/logger.js';
export type {
  HttpProtocolAdapter,
  ProtocolAdapter,
  ProtocolAdapterContext,
} from './interfaces/protocol-adapter.js';
export { isHttpProtocolAdapter } from './interfaces/protocol-adapter.js';
export type { Clock, IdGenerator } from './interfaces/runtime.js';
export { systemClock } from './interfaces/runtime.js';
export type {
  ListOptions,
  PaymentAttemptReservation,
  PaymentAttemptUpdate,
  ReceiptStore,
} from './interfaces/store.js';
