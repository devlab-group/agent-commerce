/**
 * `GET /.well-known/agent-commerce` — merchant + every adapter/provider/store
 * `AdapterDescriptor`, protocol/spec versions. This route is unauthenticated
 * by design, so nothing here may be a credential.
 *
 * The x402 settlement destination (`payTo`), `network` and `asset` ARE
 * public information — a payer needs them (plus scheme/amount, which travel
 * in the challenge's `accepts` array) to construct a payment, and `payTo` is
 * visible on-chain the moment any transfer lands. `rpcUrl` is different and
 * is deliberately NOT published here: every commercial EVM RPC
 * provider embeds an API key in the URL itself (Alchemy's `/v2/<KEY>`,
 * Infura's `/v3/<KEY>`, QuickNode's per-endpoint token) — on any non-local
 * deployment, echoing it back on an open route hands out a live credential
 * to anyone who asks. The facilitator URL is withheld for the same reason,
 * and the facilitator private key never appears at all. `doctor`'s
 * live/local cross-check (src/cli) only reads `asset`/`network`/`payTo` from
 * this document, so dropping `rpcUrl` does not affect it.
 *
 * `WellKnownDocument` is also exported via the package's
 * `./well-known.js` subpath (non-frozen — see docs/contracts.md's change
 * log) so `demo/dashboard`'s hand-maintained mirror of this shape
 * (`types.ts`) can assert assignability against the real type instead of
 * silently drifting — which is exactly how it twice shipped `rpcUrl` as
 * non-optional after this file stopped sending it. Consuming this as
 * `import type` only is what keeps the dashboard's browser bundle free of
 * Fastify/pino/better-sqlite3: a type-only import is erased entirely by any
 * TypeScript-aware bundler (esbuild, swc, tsc), independent of whatever
 * runtime code this file also happens to export — the same property
 * `src/core`'s `./execution` subpath already relies on.
 */

import type { GatewayConfig } from '../config/index.js';
import type {
  AdapterDescriptor,
  AdapterHealth,
  Clock,
  PaymentProvider,
  ReceiptStore,
} from '../core/index.js';
import {
  type DeploymentMode,
  requireNetworkProfile,
  resolveDeploymentMode,
} from '../payments/x402/networks.js';
import { PACKAGE_VERSION } from '../version.js';
import { type AdapterRuntime, getAdapterHealth } from './adapters.js';

/**
 * The spec version is deliberately NOT derived from `PACKAGE_VERSION`. It
 * names the wire contract a client negotiates against, which changes only
 * when that contract does — a patch release of this package speaks the same
 * spec, and announcing a new one on every version bump would tell every
 * client the protocol moved when it did not.
 */
const GATEWAY_SUPPORTED_SPEC = 'agent-commerce/v0.1.0-alpha';

export interface WellKnownDocument {
  readonly gateway: { readonly implementationVersion: string; readonly supportedSpec: string };
  readonly merchant: GatewayConfig['merchant'];
  readonly protocols: GatewayConfig['protocols'];
  readonly adapters: ReadonlyArray<AdapterDescriptor & { readonly health: AdapterHealth }>;
  readonly paymentProviders: readonly AdapterDescriptor[];
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
      /** What this deployment actually is. */
      readonly mode: DeploymentMode;
    };
  };
}

export interface BuildWellKnownOptions {
  readonly config: GatewayConfig;
  readonly paymentProviders: readonly PaymentProvider[];
  readonly store: ReceiptStore;
  readonly adapterRuntimes: readonly AdapterRuntime[];
  readonly clock: Clock;
}

export async function buildWellKnownDocument(
  options: BuildWellKnownOptions,
): Promise<WellKnownDocument> {
  const adapters = await Promise.all(
    options.adapterRuntimes.map(async (runtime) => ({
      ...runtime.adapter.descriptor,
      health: await getAdapterHealth(runtime, options.clock),
    })),
  );

  const x402 = options.config.payments.x402;

  return {
    gateway: {
      implementationVersion: PACKAGE_VERSION,
      supportedSpec: GATEWAY_SUPPORTED_SPEC,
    },
    merchant: options.config.merchant,
    protocols: options.config.protocols,
    adapters,
    paymentProviders: options.paymentProviders.map((provider) => provider.descriptor),
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
              // Never the signerPrivateKey, and never the facilitator URL:
              // a facilitator endpoint is a per-deployment operational detail
              // that can carry a tenant path or an API key, exactly like
              // `rpcUrl` above. Only whether it is local or remote is public.
              facilitator: { mode: x402.facilitator.mode },
              // Chain id 84532 is shared between the local dev chain and
              // public Base Sepolia, so the network id alone cannot say which
              // one a client is talking to. This can.
              mode: resolveDeploymentMode(
                requireNetworkProfile(x402.network, 'payments.x402.network'),
                x402.facilitator.mode,
              ),
            },
          }
        : {}),
    },
  };
}
