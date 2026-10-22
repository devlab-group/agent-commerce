// The normalized configuration the rest of the gateway reads
import type { Ap2AuthorizationConfig } from '../../authorization/ap2/types';
import type { CommerceResource } from '../../core';
import type { MppNetwork } from '../../payments/mpp/constants';
import type { X402FacilitatorConfig } from '../../payments/x402/guardrails';
import type { CustomNetworks } from '../../payments/x402/networks';
import type { X402PaymentFlow } from '../../payments/x402/payment-flow';
import type { AcpCheckoutOperation } from '../../protocols/acp/constants';

/** Optional ACP discovery metadata. Absent fields are omitted from the document */
export interface AcpDiscoveryConfig {
  readonly documentationUrl?: string;
  readonly supportedCurrencies?: readonly string[];
  readonly supportedLocales?: readonly string[];
  readonly interventionTypes?: readonly string[];
}

/**
 * Discriminated on `enabled`, so an enabled ACP config carries everything the
 * adapter needs; a half-configured checkout is rejected at load
 */
export type AcpProtocolConfig =
  | { readonly enabled: false; readonly mountPath: string }
  | {
      readonly enabled: true;
      readonly mountPath: string;
      readonly auth: { readonly type: 'bearer'; readonly token: string };
      readonly idempotency: {
        readonly path: string;
        readonly retentionHours: number;
        readonly merchantIdempotent: boolean;
      };
      readonly checkout: {
        readonly operations: Readonly<Record<AcpCheckoutOperation, string>>;
      };
      readonly discovery?: AcpDiscoveryConfig;
    };

/** One resolved x402 option: where a payment settles and in which token */
export interface X402OptionConfig {
  readonly network: string;
  /** This network's RPC: `payments.x402.networks.<id>.rpcUrl`, else `payments.x402.rpcUrl` */
  readonly rpcUrl: string;
  readonly asset: string;
  /** EIP-712 domain of the token; always present for EIP-3009 */
  readonly assetName?: string;
  readonly assetVersion?: string;
  readonly assetDecimals: number;
  readonly payTo: string;
  /** Absent for EIP-3009, the default */
  readonly assetTransferMethod?: 'permit2';
}

export interface GatewayConfig {
  readonly version: 1;
  readonly merchant: { readonly id: string; readonly name: string; readonly publicBaseUrl: string };
  readonly server: {
    readonly port: number;
    readonly host: string;
    readonly adminToken?: string;
    readonly allowedOrigins: readonly string[];
  };
  readonly storage: { readonly receipts: { readonly driver: 'sqlite'; readonly path: string } };
  readonly protocols: {
    readonly http: { readonly enabled: boolean };
    readonly mcp: { readonly enabled: boolean; readonly mountPath: string };
    readonly a2a: { readonly enabled: boolean; readonly mountPath: string };
    readonly acp: AcpProtocolConfig;
  };
  /** Canonical resources, already normalized */
  readonly resources: readonly CommerceResource[];
  readonly payments: {
    readonly x402?: {
      readonly enabled: boolean;
      readonly network: string;
      readonly rpcUrl: string;
      readonly asset: string;
      /** Always present for EIP-3009; a Permit2 option may have none */
      readonly assetName?: string;
      readonly assetVersion?: string;
      readonly assetDecimals: number;
      readonly payTo: string;
      /** Absent for EIP-3009, the default */
      readonly assetTransferMethod?: 'permit2';
      readonly maxTimeoutSeconds: number;
      /** Defaults to `authorization`, the x402 default */
      readonly paymentFlow?: X402PaymentFlow;
      /** Resources whose `paymentFlow` overrides the rail's, by resource id */
      readonly resourcePaymentFlows?: Readonly<Record<string, X402PaymentFlow>>;
      /** Resources that set `mimeType`, by resource id; others declare `application/json` */
      readonly resourceMimeTypes?: Readonly<Record<string, string>>;
      readonly facilitator: X402FacilitatorConfig;
      readonly allowMainnet?: boolean;
      readonly allowUnauthenticatedFacilitator?: boolean;
      /** EVM networks declared beside the built-in ones, by CAIP-2 id */
      readonly networks?: CustomNetworks;
      /**
       * Resolved options in challenge order; fields above mirror the first.
       * Omit for manually built single-option configs that skip `parseConfig`
       */
      readonly options?: readonly X402OptionConfig[];
      /**
       * Resource `x402.accepts` overrides by id, replacing `options`.
       * Absent when no resource overrides its offers.
       */
      readonly resourceOptions?: Readonly<Record<string, readonly X402OptionConfig[]>>;
      /**
       * Experimental ERC-8409 quotes. Config loading includes this field only
       * when `quote.enabled` is true. The signing key must not hold funds.
       */
      readonly quote?: { readonly signerPrivateKey: string };
    };
    readonly mpp?: {
      readonly enabled: boolean;
      readonly network: MppNetwork;
      readonly rpcUrl: string;
      readonly asset: string;
      readonly assetName: string;
      readonly assetVersion: string;
      readonly recipient: string;
      readonly realm: string;
      readonly challengeSecret: string;
      readonly challengeTtlSeconds?: number;
      /** Defaults to `upfront`: settle before the backend call */
      readonly paymentFlow?: X402PaymentFlow;
      /** Resources whose `paymentFlow` overrides the rail's, by resource id */
      readonly resourcePaymentFlows?: Readonly<Record<string, X402PaymentFlow>>;
      readonly facilitator: X402FacilitatorConfig;
      readonly allowMainnet?: boolean;
      readonly allowUnauthenticatedFacilitator?: boolean;
    };
  };
  /** Absent when no `authorization:` block is configured */
  readonly authorization?: { readonly ap2: Ap2AuthorizationConfig };
}

export interface NormalizedProtocols {
  readonly http: { readonly enabled: boolean };
  readonly mcp: { readonly enabled: boolean; readonly mountPath: string };
  readonly a2a: { readonly enabled: boolean; readonly mountPath: string };
  readonly acp: AcpProtocolConfig;
}
