// Readiness: each offer's chain, asset and facilitator support, cached briefly

import type { SupportedKind } from '@x402/core/types';
import { PERMIT2_ADDRESS, x402ExactPermit2ProxyAddress } from '@x402/evm';
import { type AdapterHealth, CommerceError } from '../../../core';
import { redactedErrorText } from '../../../core/errors';
import { isRecord } from '../../../core/is-record';
import { normalizeAddress } from '../addresses';
import type { createLocalPublicClient } from '../chain';
import type { FacilitatorBinding } from '../facilitator';
import { describeDeploymentMode } from '../networks';
import { x402OfferName } from '../options';
import { HEALTH_TIMEOUT_MS, X402_VERSION } from './constants';
import type { NanoOffer, NearOffer, Offer, ProviderContext, SvmOffer } from './types';

/** Builds the provider's `health`, which probes every offer and caches the result */
export function createHealthCheck(ctx: ProviderContext): () => Promise<AdapterHealth> {
  const { offers, clock, deploymentMode, remoteBinding, svm, near, nano } = ctx;

  // One offer's chain, asset and facilitator support. `kinds` fetches the
  // remote facilitator's `/supported` once per probe, shared by every offer.
  async function offerHealth(
    offer: Offer,
    kinds: () => Promise<readonly SupportedKind[]>,
  ): Promise<{ readonly status: 'pass' | 'fail'; readonly detail: string }> {
    if (offer.family === 'svm') return svmOfferHealth(offer, kinds);
    if (offer.family === 'near') return nearOfferHealth(offer, kinds);
    if (offer.family === 'nano') return nanoOfferHealth(offer);
    const { profile, rpcOrigin, healthClient, binding } = offer;
    const chainId = await healthClient.getChainId();
    if (chainId !== profile.chainId) {
      return {
        status: 'fail',
        detail: `RPC at ${rpcOrigin} reports chain id ${chainId}, expected ${profile.chainId} (${profile.displayName})`,
      };
    }

    const code = await healthClient.getCode({ address: offer.asset });
    if (!code || code === '0x') {
      return {
        status: 'fail',
        detail: `No contract code found at configured asset address ${offer.asset}`,
      };
    }
    // Permit2 offers settle through two contracts the merchant does not deploy
    if (offer.method === 'permit2') {
      for (const [name, address] of PERMIT2_CONTRACTS) {
        const deployed = await healthClient.getCode({ address });
        if (!deployed || deployed === '0x') {
          return {
            status: 'fail',
            detail: `No ${name} contract code found at ${address} on ${profile.displayName}`,
          };
        }
      }
    }
    const contracts = `asset ${offer.asset}${offer.method === 'permit2' ? ', Permit2 and its x402 proxy' : ''}`;

    if (binding.kind === 'remote') {
      // Reachable is not enough: a facilitator that does not carry our
      // scheme on our network fails every payment after the buyer has signed
      const supportsUs = (await kinds()).some(
        (kind) =>
          kind.x402Version === X402_VERSION &&
          kind.scheme === 'exact' &&
          kind.network === offer.network,
      );
      if (!supportsUs) {
        return {
          status: 'fail',
          detail:
            `Facilitator ${binding.describe} does not advertise x402 v${X402_VERSION} scheme=exact ` +
            `on ${offer.network} (${profile.displayName}); no payment on this deployment can settle`,
        };
      }
      return {
        status: 'pass',
        detail:
          `${describeDeploymentMode(deploymentMode)}: RPC ${rpcOrigin} reachable, chain id ` +
          `${profile.chainId} (${profile.displayName}), ${contracts} have code, ` +
          `facilitator ${binding.describe} supports exact/${offer.network}`,
      };
    }

    // An RPC reports whatever chain id it was started with, so the id cannot
    // prove this is a dev chain. An Anvil-only RPC method must answer before
    // a local facilitator counts as healthy.
    const isAnvil = await probeIsAnvilNode(healthClient);
    if (!isAnvil) {
      return {
        status: 'fail',
        detail:
          `RPC at ${rpcOrigin} reports chain id ${profile.chainId} but does not answer ` +
          '"anvil_nodeInfo", so it does not look like a local Anvil dev node. Refusing to treat it ' +
          'as safe for a local-facilitator dev key.',
      };
    }

    return {
      status: 'pass',
      detail:
        `${describeDeploymentMode(deploymentMode)}: RPC ${rpcOrigin} reachable, chain id ` +
        `${profile.chainId}, ${contracts} have code, confirmed Anvil dev node`,
    };
  }

  // A Solana offer's cluster, mint and fee payer. The CAIP-2 reference is the
  // start of the genesis hash, so the RPC proves which cluster it serves.
  async function svmOfferHealth(
    offer: SvmOffer,
    kinds: () => Promise<readonly SupportedKind[]>,
  ): Promise<{ readonly status: 'pass' | 'fail'; readonly detail: string }> {
    const { profile, rpcOrigin, binding } = offer;
    // A missing Solana peer fails readiness, not the first paid request
    const svmModule = await svm();
    const genesis = await jsonRpc(offer.rpcUrl, 'getGenesisHash', []);
    const cluster = typeof genesis === 'string' ? `solana:${genesis.slice(0, 32)}` : undefined;
    if (cluster !== offer.network) {
      return {
        status: 'fail',
        detail: `RPC at ${rpcOrigin} serves ${cluster ?? 'an unknown cluster'}, expected ${offer.network} (${profile.displayName})`,
      };
    }
    const mint = await jsonRpc(offer.rpcUrl, 'getAccountInfo', [
      offer.asset,
      { encoding: 'base64' },
    ]);
    const mintInfo = readMint(mint);
    if (mintInfo === undefined) {
      return {
        status: 'fail',
        detail: `No initialized token mint found at configured asset address ${offer.asset}`,
      };
    }
    const { decimals, tokenProgram } = mintInfo;
    if (decimals !== offer.assetDecimals) {
      return {
        status: 'fail',
        detail: `Mint ${offer.asset} has ${decimals} decimals, configured ${offer.assetDecimals}`,
      };
    }
    // Without the payee's token account every payment fails the facilitator's
    // simulation, after the buyer signed
    const payeeAccount = await svmModule.associatedTokenAccount(
      offer.payTo,
      offer.asset,
      tokenProgram,
    );
    const account = await jsonRpc(offer.rpcUrl, 'getAccountInfo', [
      payeeAccount,
      { encoding: 'base64' },
    ]);
    const accountValue = isRecord(account) ? account['value'] : undefined;
    if (!isRecord(accountValue) || accountValue['owner'] !== tokenProgram) {
      return {
        status: 'fail',
        detail: `payTo ${offer.payTo} has no token account for mint ${offer.asset}; create its associated token account (${payeeAccount}) before taking payments`,
      };
    }
    const feePayer = (await kinds()).find(
      (kind) =>
        kind.x402Version === X402_VERSION &&
        kind.scheme === 'exact' &&
        kind.network === offer.network,
    )?.extra?.['feePayer'];
    if (typeof feePayer !== 'string' || normalizeAddress(profile, feePayer) === undefined) {
      return {
        status: 'fail',
        detail:
          `Facilitator ${binding.describe} does not advertise x402 v${X402_VERSION} scheme=exact ` +
          `on ${offer.network} (${profile.displayName}) with a fee payer; no payment on this deployment can settle`,
      };
    }
    return {
      status: 'pass',
      detail:
        `${describeDeploymentMode(deploymentMode)}: RPC ${rpcOrigin} serves ${profile.displayName}, ` +
        `mint ${offer.asset} has ${decimals} decimals and a token account for ${offer.payTo}, ` +
        `facilitator ${binding.describe} supports ` +
        `exact/${offer.network} with fee payer ${feePayer}`,
    };
  }

  // A NEAR offer's chain, token and merchant registration. The RPC's `status`
  // names the chain it serves; an account suffix such as `.testnet` proves nothing.
  async function nearOfferHealth(
    offer: NearOffer,
    kinds: () => Promise<readonly SupportedKind[]>,
  ): Promise<{ readonly status: 'pass' | 'fail'; readonly detail: string }> {
    const { profile, rpcOrigin, binding, rpcUrl } = offer;
    // A missing NEAR peer fails readiness, not the first paid request
    await near();
    const status = await jsonRpc(rpcUrl, 'status', []);
    const chainId = isRecord(status) ? status['chain_id'] : undefined;
    const expected = offer.network.slice('near:'.length);
    if (chainId !== expected) {
      return {
        status: 'fail',
        detail: `RPC at ${rpcOrigin} serves chain ${String(chainId ?? 'unknown')}, expected ${expected} (${profile.displayName})`,
      };
    }
    const token = await jsonRpc(rpcUrl, 'query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: offer.asset,
    });
    if (!isRecord(token) || token['code_hash'] === NEAR_EMPTY_CODE_HASH) {
      return {
        status: 'fail',
        detail: `No contract code found at configured asset account ${offer.asset}`,
      };
    }
    const metadata = await nearView(rpcUrl, offer.asset, 'ft_metadata', {});
    const decimals = isRecord(metadata) ? metadata['decimals'] : undefined;
    if (decimals !== offer.assetDecimals) {
      return {
        status: 'fail',
        detail: `Token ${offer.asset} has ${String(decimals)} decimals, configured ${offer.assetDecimals}`,
      };
    }
    // An unregistered recipient makes every transfer fail after the relayer
    // paid for it. A token without NEP-145 storage management needs none.
    let registered = true;
    try {
      registered =
        (await nearView(rpcUrl, offer.asset, 'storage_balance_of', {
          account_id: offer.payTo,
        })) !== null;
    } catch (err) {
      if (!/MethodNotFound|MethodResolveError/i.test(redactedErrorText(err))) throw err;
    }
    if (!registered) {
      return {
        status: 'fail',
        detail: `payTo ${offer.payTo} has no storage registered with token ${offer.asset}; register it (NEP-145 storage_deposit) before taking payments`,
      };
    }
    const listed = (await kinds()).some(
      (kind) =>
        kind.x402Version === X402_VERSION &&
        kind.scheme === 'exact' &&
        kind.network === offer.network,
    );
    if (!listed) {
      return {
        status: 'fail',
        detail:
          `Facilitator ${binding.describe} does not advertise x402 v${X402_VERSION} scheme=exact ` +
          `on ${offer.network} (${profile.displayName}); no payment on this deployment can settle`,
      };
    }
    return {
      status: 'pass',
      detail:
        `${describeDeploymentMode(deploymentMode)}: RPC ${rpcOrigin} serves ${expected}, ` +
        `token ${offer.asset} has ${decimals} decimals and storage for ${offer.payTo}, ` +
        `facilitator ${binding.describe} supports exact/${offer.network}`,
    };
  }

  // A Nano offer needs only a node of the live network: no facilitator, no token
  async function nanoOfferHealth(
    offer: NanoOffer,
  ): Promise<{ readonly status: 'pass' | 'fail'; readonly detail: string }> {
    const nanoModule = await nano();
    const live = await nanoModule.isLiveNanoNode(
      nanoModule.createNanoRpc(offer.rpcUrl, HEALTH_TIMEOUT_MS),
    );
    return live
      ? {
          status: 'pass',
          detail: `${describeDeploymentMode(deploymentMode)}: Nano node ${offer.rpcOrigin} serves the live network; payments to ${offer.payTo} are read from it, without a facilitator`,
        }
      : {
          status: 'fail',
          detail: `RPC at ${offer.rpcOrigin} does not report the live Nano network`,
        };
  }

  // Check all offers and report each status; any failure fails readiness.
  // Challenges retain the complete offer list.
  async function computeHealth(): Promise<AdapterHealth> {
    const startedAt = clock.monotonicMs();
    const checkedAt = clock.nowIso();
    let supported: Promise<readonly SupportedKind[]> | undefined;
    const kinds = () => {
      supported ??= (remoteBinding as Extract<FacilitatorBinding, { kind: 'remote' }>)
        .supported()
        .then((response) => response.kinds);
      return supported;
    };

    const results = await Promise.all(
      offers.map((offer) =>
        offerHealth(offer, kinds).catch((err: unknown) => ({
          status: 'fail' as const,
          detail: `x402 health check failed: ${redactedErrorText(err)}`,
        })),
      ),
    );
    const failed = results.some((result) => result.status === 'fail');
    const details = offers.flatMap((offer, index) => {
      const result = results[index] as (typeof results)[number];
      if (failed && result.status !== 'fail') return [];
      return [offers.length === 1 ? result.detail : `${x402OfferName(offer)}: ${result.detail}`];
    });
    return {
      status: failed ? 'fail' : 'pass',
      detail: details.join('; '),
      components: offers.map((offer, index) => ({
        name: x402OfferName(offer),
        status: (results[index] as (typeof results)[number]).status,
      })),
      checkedAt,
      durationMs: clock.monotonicMs() - startedAt,
    };
  }

  // A probe makes several upstream calls, and `/ready` is unauthenticated.
  // A short TTL plus one shared in-flight probe keeps upstream volume independent
  // of request volume, for library callers as well as the gateway, whose
  // readiness probe adds its own cache on top. Pass and fail share the TTL: a
  // shorter one for fail would bring the load back during an RPC outage,
  // exactly when each call is slowest.
  const HEALTH_CACHE_MS = 5_000;
  let cachedHealth: { at: number; value: AdapterHealth } | undefined;
  let inFlightHealth: Promise<AdapterHealth> | undefined;

  async function health(): Promise<AdapterHealth> {
    const now = clock.monotonicMs();
    if (cachedHealth && now - cachedHealth.at < HEALTH_CACHE_MS) {
      return cachedHealth.value;
    }
    if (inFlightHealth) return inFlightHealth;

    inFlightHealth = computeHealth()
      .then((value) => {
        cachedHealth = { at: clock.monotonicMs(), value };
        return value;
      })
      .finally(() => {
        inFlightHealth = undefined;
      });
    return inFlightHealth;
  }

  return health;
}

const PERMIT2_CONTRACTS = [
  ['Permit2', PERMIT2_ADDRESS],
  ['x402 exact Permit2 proxy', x402ExactPermit2ProxyAddress],
] as const;

const TOKEN_PROGRAMS: ReadonlySet<string> = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

// The decimals and owning token program of an initialized SPL Token or
// Token-2022 mint, from a base64 `getAccountInfo` result: byte 44 holds the
// decimals, byte 45 the initialized flag
function readMint(
  result: unknown,
): { readonly decimals: number; readonly tokenProgram: string } | undefined {
  const value = isRecord(result) ? result['value'] : undefined;
  if (!isRecord(value)) return undefined;
  const owner = value['owner'];
  if (typeof owner !== 'string' || !TOKEN_PROGRAMS.has(owner)) return undefined;
  const data = value['data'];
  if (!Array.isArray(data) || typeof data[0] !== 'string') return undefined;
  const bytes = Buffer.from(data[0], 'base64');
  const decimals = bytes[44];
  return bytes.length >= 82 && bytes[45] === 1 && decimals !== undefined
    ? { decimals, tokenProgram: owner }
    : undefined;
}

// One JSON-RPC call for health(), bounded like the EVM client's
async function jsonRpc(rpcUrl: string, method: string, params: unknown): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined) {
    throw new CommerceError(
      'PAYMENT_PROVIDER_UNAVAILABLE',
      `RPC ${method} failed: ${JSON.stringify(body.error)}`,
    );
  }
  return body.result;
}

// A NEAR contract view call at final finality, its result parsed as JSON
async function nearView(
  rpcUrl: string,
  accountId: string,
  method: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await jsonRpc(rpcUrl, 'query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: accountId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  const bytes = isRecord(result) ? result['result'] : undefined;
  if (!Array.isArray(bytes)) {
    throw new CommerceError(
      'PAYMENT_PROVIDER_UNAVAILABLE',
      `NEAR view ${method} returned no result`,
    );
  }
  return JSON.parse(Buffer.from(bytes as number[]).toString('utf8'));
}

// The code hash of an account without a contract
const NEAR_EMPTY_CODE_HASH = '11111111111111111111111111111111';

/**
 * True only when the RPC answers Anvil's own `anvil_nodeInfo` method. A public
 * node, Base Sepolia included, answers "method not found". Never throws.
 */
async function probeIsAnvilNode(
  client: ReturnType<typeof createLocalPublicClient>,
): Promise<boolean> {
  // Anvil-only method, absent from viem's typed PublicRpcSchema, hence the cast
  const request = client.request as unknown as (args: {
    method: string;
    params: unknown[];
  }) => Promise<unknown>;
  try {
    await request({ method: 'anvil_nodeInfo', params: [] });
    return true;
  } catch {
    return false;
  }
}
