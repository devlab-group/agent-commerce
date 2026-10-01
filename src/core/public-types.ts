/**
 * FROZEN PUBLIC CONTRACT since v0.1.0-alpha (freeze record:
 * docs/contracts.md). The canonical domain model, errors and injection
 * interfaces are re-exported here. Changes to this public API require contract
 * review; `npm run check:contract` compares the resolved types with a committed
 * baseline.
 *
 * Do not redeclare these shapes locally. If something is missing, add it here
 * rather than creating a parallel type.
 */

export type {
  AuthorizationFinalizeContext,
  AuthorizationProvider,
  AuthorizationRecord,
  AuthorizationRequirement,
  AuthorizationSubmission,
  AuthorizationVerification,
  AuthorizationVerificationContext,
} from './domain/authorization';
// --- canonical domain ------------------------------------------------------
export type {
  AdapterDescriptor,
  AdapterHealth,
  AuthorizationMethodName,
  DecimalAmount,
  IsoTimestamp,
  JsonSchema,
  PaymentMethodName,
  ProtocolName,
} from './domain/common';
export { PAYMENT_METHOD_NAMES, PROTOCOL_NAMES } from './domain/common';
export type { CommerceEvent, CommerceEventType, EventSink } from './domain/event';
export { COMMERCE_EVENT_TYPES } from './domain/event';

export type {
  PaymentChallenge,
  PaymentContext,
  PaymentProvider,
  PaymentRequirement,
  PaymentResult,
  PaymentSettlementContext,
  PaymentSubmission,
  PaymentVerificationContext,
} from './domain/payment';

export type { CommerceReceipt, PaymentAttempt } from './domain/receipt';
export type {
  CanonicalRequest,
  DeliveredOutcome,
  ExecutionOutcome,
  ExecutionPipeline,
  PaymentRequiredOutcome,
} from './domain/request';
export type {
  BackendHandler,
  BackendMethod,
  CommerceResource,
  Pricing,
  ResourceRegistry,
} from './domain/resource';
export { DEFAULT_BACKEND_TIMEOUT_MS } from './domain/resource';
export type {
  DeliverySummary,
  ErrorEnvelope,
  PaymentRequiredEnvelope,
} from './domain/wire';
export {
  AUTHORIZATION_HEADER,
  AUTHORIZATION_INPUT_FIELD,
  DELIVERY_SUMMARY_META_KEY,
  extractReservedInputFields,
  isPaymentRequiredEnvelope,
  MAX_AUTHORIZATION_HEADER_BYTES,
  PAYMENT_HEADER,
  PAYMENT_INPUT_FIELD,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  parseAuthorizationHeader,
  parseAuthorizationSubmission,
  RESERVED_INPUT_FIELDS,
  toDeliverySummary,
  toErrorEnvelope,
  toPaymentRequiredEnvelope,
} from './domain/wire';

// --- errors ----------------------------------------------------------------
export type { CommerceErrorCode, CommerceErrorInfo, CommerceErrorOptions } from './errors';
export {
  COMMERCE_ERROR_CODES,
  COMMERCE_ERROR_HTTP_STATUS,
  CommerceError,
  isCommerceError,
  RETRYABLE_ERROR_CODES,
  toCommerceError,
} from './errors';

// --- injection boundaries --------------------------------------------------
export type { BackendExecutor, BackendRequest, BackendResponse } from './interfaces/backend';
export type { Logger } from './interfaces/logger';
export { NOOP_LOGGER } from './interfaces/logger';
export type {
  AdapterHttpRoute,
  HttpProtocolAdapter,
  ProtocolAdapter,
  ProtocolAdapterContext,
} from './interfaces/protocol-adapter';
export { isHttpProtocolAdapter } from './interfaces/protocol-adapter';
export type { Clock, IdGenerator } from './interfaces/runtime';
export { systemClock } from './interfaces/runtime';
export type {
  ListOptions,
  PaymentAttemptReservation,
  PaymentAttemptUpdate,
  ReceiptStore,
} from './interfaces/store';
