// The gateway's JSON shapes, imported as types only: Vite erases them, so the
// browser bundle takes no code from `src/`
import type { WellKnownDocument } from '../../../../src/gateway/well-known';

export type {
  AdapterDescriptor,
  AdapterHealth,
  CommerceEvent,
  CommerceEventType,
  CommerceReceipt,
  PaymentResult,
  Pricing,
} from '../../../../src/core/public-types';
export type { PublicResource } from '../../../../src/gateway/public-resource';
export type { WellKnownDocument };

export type AdapterWithHealth = WellKnownDocument['adapters'][number];
