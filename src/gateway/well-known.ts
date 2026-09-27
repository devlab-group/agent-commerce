/**
 * `GET /.well-known/agent-commerce`: the merchant, the `AdapterDescriptor` of
 * every adapter, provider and store, and the protocol and spec versions. The
 * route is unauthenticated, so nothing here may be a credential.
 *
 * The settlement destination, `network` and `asset` are public: a payer needs
 * them to build a payment, and the destination is visible on-chain after any
 * transfer. `rpcUrl` and the facilitator URL are withheld, because commercial
 * providers embed an API key in the URL (Alchemy's `/v2/<KEY>`, Infura's
 * `/v3/<KEY>`, QuickNode's per-endpoint token). The facilitator private key
 * never appears.
 */

import type { GatewayConfig } from '../config';
import type {
  AdapterDescriptor,
  AdapterHealth,
  AuthorizationProvider,
  PaymentProvider,
  ReceiptStore,
} from '../core';
import { MPP_PROFILE } from '../payments/mpp/constants';
import {
  type DeploymentMode,
  requireNetworkProfile,
  resolveDeploymentMode,
} from '../payments/x402/networks';
import { PACKAGE_VERSION } from '../version';
import type { ProbedAdapter } from './readiness';

// Not derived from `PACKAGE_VERSION`: it names the wire contract a client
// negotiates against, which changes only when that contract does
const GATEWAY_SUPPORTED_SPEC = 'agent-commerce/v1.0.0';

/**
 * The protocol block as published, not as configured.
 *
 * Built field by field rather than spread from `config.protocols`, because that
 * object carries `protocols.acp.auth.token` - a live credential - plus the
 * idempotency database path and the operation-to-resource mapping. This route
 * is unauthenticated, so a future config field must be added here deliberately
 * to become public, never by inheriting a shape.
 */
export interface WellKnownProtocols {
  readonly http: { readonly enabled: boolean };
  readonly mcp: { readonly enabled: boolean; readonly mountPath: string };
  readonly a2a: { readonly enabled: boolean; readonly mountPath: string };
  readonly acp: { readonly enabled: boolean; readonly mountPath: string };
}

export interface WellKnownDocument {
  readonly gateway: { readonly implementationVersion: string; readonly supportedSpec: string };
  readonly merchant: GatewayConfig['merchant'];
  readonly protocols: WellKnownProtocols;
  readonly adapters: ReadonlyArray<AdapterDescriptor & { readonly health: AdapterHealth }>;
  readonly paymentProviders: readonly AdapterDescriptor[];
  /**
   * Empty unless the gateway has an authorization provider (`authorization.ap2.enabled`).
   * Listed apart from `paymentProviders` because an authorization method is not
   * a payment rail and must never be selectable as one.
   */
  readonly authorizationProviders: readonly AdapterDescriptor[];
  readonly store: AdapterDescriptor;
  readonly payments: {
    readonly x402?: {
      readonly enabled: boolean;
      readonly network: string;
      readonly asset: string;
      readonly assetName: string;
      readonly assetVersion: string;
      readonly assetDecimals: number;
      readonly payTo: string;
      readonly maxTimeoutSeconds: number;
      readonly facilitator: { readonly mode: 'local' | 'remote' };
      /** `local`, `testnet` or `mainnet`, from the network and facilitator together */
      readonly mode: DeploymentMode;
    };
    /** Public settlement fields; excludes the challenge secret and facilitator credentials */
    readonly mpp?: {
      readonly enabled: boolean;
      readonly network: string;
      readonly asset: string;
      readonly assetName: string;
      readonly assetVersion: string;
      readonly assetDecimals: number;
      readonly recipient: string;
      readonly facilitator: { readonly mode: 'local' | 'remote' };
      readonly mode: DeploymentMode;
    };
  };
}

export interface BuildWellKnownOptions {
  readonly config: GatewayConfig;
  readonly paymentProviders: readonly PaymentProvider[];
  readonly authorizationProviders: readonly AuthorizationProvider[];
  readonly store: ReceiptStore;
  /** From the memoized readiness probe, so this route shares `/ready`'s `health()` calls */
  readonly adapters: readonly ProbedAdapter[];
}

/**
 * Drops `detail` from a health result; `/ready` replaces it with a fixed
 * vocabulary. For a thrown `health()` or a start failure `detail` holds the
 * raw error message, often a module path or an internal hostname, and
 * `createGateway` accepts arbitrary adapters whose details this code cannot
 * vouch for.
 */
function publicHealth(health: AdapterHealth): AdapterHealth {
  const { detail: _detail, ...rest } = health;
  return rest;
}

function publicProtocols(protocols: GatewayConfig['protocols']): WellKnownProtocols {
  return {
    http: { enabled: protocols.http.enabled },
    mcp: { enabled: protocols.mcp.enabled, mountPath: protocols.mcp.mountPath },
    a2a: { enabled: protocols.a2a.enabled, mountPath: protocols.a2a.mountPath },
    acp: { enabled: protocols.acp.enabled, mountPath: protocols.acp.mountPath },
  };
}

export function buildWellKnownDocument(options: BuildWellKnownOptions): WellKnownDocument {
  const adapters = options.adapters.map(({ descriptor, health }) => ({
    ...descriptor,
    health: publicHealth(health),
  }));

  const { x402, mpp } = options.config.payments;

  return {
    gateway: {
      implementationVersion: PACKAGE_VERSION,
      supportedSpec: GATEWAY_SUPPORTED_SPEC,
    },
    merchant: options.config.merchant,
    protocols: publicProtocols(options.config.protocols),
    adapters,
    paymentProviders: options.paymentProviders.map((provider) => provider.descriptor),
    authorizationProviders: options.authorizationProviders.map((provider) => provider.descriptor),
    store: options.store.descriptor,
    payments: {
      ...(x402 !== undefined
        ? {
            x402: {
              enabled: x402.enabled,
              network: x402.network,
              asset: x402.asset,
              assetName: x402.assetName,
              assetVersion: x402.assetVersion,
              assetDecimals: x402.assetDecimals,
              payTo: x402.payTo,
              maxTimeoutSeconds: x402.maxTimeoutSeconds,
              // Only local or remote is public: the facilitator URL can carry
              // a tenant path or an API key, and the signer key is secret
              facilitator: { mode: x402.facilitator.mode },
              // Chain id 84532 is both the local dev chain and public Base
              // Sepolia, so the network id alone cannot say which one this is
              mode: resolveDeploymentMode(
                requireNetworkProfile(x402.network, 'payments.x402.network'),
                x402.facilitator.mode,
              ),
            },
          }
        : {}),
      ...(mpp !== undefined
        ? {
            mpp: {
              enabled: mpp.enabled,
              network: mpp.network,
              asset: mpp.asset,
              assetName: mpp.assetName,
              assetVersion: mpp.assetVersion,
              assetDecimals: MPP_PROFILE.assetDecimals,
              recipient: mpp.recipient,
              facilitator: { mode: mpp.facilitator.mode },
              mode: resolveDeploymentMode(
                requireNetworkProfile(mpp.network, 'payments.mpp.network'),
                mpp.facilitator.mode,
              ),
            },
          }
        : {}),
    },
  };
}
