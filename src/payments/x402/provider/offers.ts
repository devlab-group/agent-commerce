// Builds each offer from its options: validation, deployment guardrails and the facilitator binding
import type { Network } from '@x402/core/types';
import { isAddress } from 'viem';
import { CommerceError } from '../../../core';
import { normalizeAddress, sameAddress } from '../addresses';
import {
  createLocalFacilitatorClient,
  createLocalPublicClient,
  type LocalFacilitatorClient,
} from '../chain';
import { assertDevKeyIsLocalOnly, assertPayToIsNotDevAddress, describeRpc } from '../dev-key-guard';
import { createRemoteFacilitatorBinding, type FacilitatorBinding } from '../facilitator';
import { resolveX402Deployment } from '../guardrails';
import { createLocalFacilitatorBinding } from '../local-facilitator';
import { type DeploymentMode, findX402Network } from '../networks';
import { HEALTH_TIMEOUT_MS } from './constants';
import { isProviderUnavailableError } from './reasons';
import type {
  Offer,
  X402MultiOfferProviderOptions,
  X402OfferOptions,
  X402ProviderOptions,
} from './types';

/**
 * Resolves and checks every offer at construction, so a misconfigured one fails
 * the provider at startup rather than on a paid request
 */
export function resolveOffers(
  inputs: readonly X402OfferOptions[],
  options: X402ProviderOptions | X402MultiOfferProviderOptions,
): {
  readonly offers: readonly Offer[];
  readonly deploymentMode: DeploymentMode;
  readonly remoteBinding: FacilitatorBinding | undefined;
} {
  // Share one remote binding, created after the first offer passes validation
  let remoteBinding: FacilitatorBinding | undefined;

  let mode: DeploymentMode | undefined;
  const seen = new Set<string>();
  const offers = inputs.map((input, index): Offer => {
    const field = (name: string) =>
      inputs.length === 1 ? `"${name}"` : `"offers[${index}].${name}"`;
    // The network decides how the other fields are read. An unknown one
    // fails in `resolveX402Deployment` below.
    const known = findX402Network(input.network, options.customNetworks);
    if (known !== undefined && known.family !== 'evm') {
      const shape =
        known.family === 'svm' ? 'a Solana address (base58, 32 bytes)' : 'a NEAR account ID';
      for (const name of ['asset', 'payTo'] as const) {
        if (normalizeAddress(known, input[name]) === undefined) {
          throw new CommerceError(
            'CONFIG_INVALID',
            `x402 provider: ${field(name)} is not ${shape}`,
          );
        }
      }
      if (input.assetTransferMethod !== undefined) {
        throw new CommerceError(
          'CONFIG_INVALID',
          `x402 provider: ${field('assetTransferMethod')} applies to EVM networks only`,
        );
      }
    } else {
      if (!isAddress(input.asset)) {
        throw new CommerceError(
          'CONFIG_INVALID',
          `x402 provider: ${field('asset')} is not a valid EVM address: ${input.asset}`,
        );
      }
      if (!isAddress(input.payTo)) {
        throw new CommerceError(
          'CONFIG_INVALID',
          `x402 provider: ${field('payTo')} is not a valid EVM address: ${input.payTo}`,
        );
      }
      // In every facilitator mode. `resolveX402Deployment` below also refuses
      // a dev payTo on any non-local deployment, whatever the RPC host.
      assertPayToIsNotDevAddress(input.rpcUrl, input.payTo);
      // The buyer signs the token's EIP-712 domain under EIP-3009, so the
      // requirement must name it. Permit2 has a domain of its own.
      if (
        (input.assetTransferMethod ?? 'eip3009') === 'eip3009' &&
        (!input.assetName || !input.assetVersion)
      ) {
        throw new CommerceError(
          'CONFIG_INVALID',
          `x402 provider: an EIP-3009 offer needs ${field('assetName')} and ${field('assetVersion')}, the token's EIP-712 domain`,
        );
      }
    }
    if (!Number.isInteger(input.assetDecimals) || input.assetDecimals < 0) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `x402 provider: ${field('assetDecimals')} must be a non-negative integer`,
      );
    }
    // The chain id is signed into the buyer's EIP-712 domain, so a network it
    // cannot be resolved from fails here, never at request time
    const deployment = resolveX402Deployment({
      network: input.network,
      ...(options.customNetworks !== undefined ? { customNetworks: options.customNetworks } : {}),
      payTo: input.payTo,
      asset: input.asset,
      ...(input.assetName !== undefined ? { assetName: input.assetName } : {}),
      ...(input.assetVersion !== undefined ? { assetVersion: input.assetVersion } : {}),
      facilitator: options.facilitator,
      ...(options.allowMainnet !== undefined ? { allowMainnet: options.allowMainnet } : {}),
      ...(options.allowUnauthenticatedFacilitator !== undefined
        ? { allowUnauthenticatedFacilitator: options.allowUnauthenticatedFacilitator }
        : {}),
    });
    const profile = deployment.profile;
    // Refuse offers mixing local, testnet and mainnet deployment modes
    if (mode !== undefined && deployment.mode !== mode) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `x402 provider: offers mix ${mode} and ${deployment.mode} networks; every offer must be on a ${mode} network`,
      );
    }
    mode = deployment.mode;
    // EVM addresses compare without case; Solana's base58 is case-sensitive
    const comparable = (value: string) => (profile.family === 'evm' ? value.toLowerCase() : value);
    const key = `${input.network}|${comparable(input.asset)}|${comparable(input.payTo)}`;
    if (seen.has(key)) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `x402 provider: ${field('network')} repeats an earlier offer of the same asset to the same payTo on ${input.network}`,
      );
    }
    seen.add(key);

    // Built once, here, rather than in settle(): an unusable key fails the
    // provider at startup, not on the first paid request after that buyer's
    // replay key is already reserved
    let binding: FacilitatorBinding;
    if (options.facilitator.mode === 'local') {
      assertDevKeyIsLocalOnly(input.rpcUrl, options.facilitator.signerPrivateKey);
      let client: LocalFacilitatorClient;
      try {
        client = createLocalFacilitatorClient(
          input.rpcUrl,
          options.facilitator.signerPrivateKey as `0x${string}`,
        );
      } catch (cause) {
        throw new CommerceError(
          'CONFIG_INVALID',
          'x402 provider: could not construct a local facilitator signer from ' +
            'facilitator.signerPrivateKey. It must be a valid 32-byte hex private key.',
          { cause },
        );
      }
      binding = createLocalFacilitatorBinding(client, input.network, isProviderUnavailableError);
    } else {
      remoteBinding ??= createRemoteFacilitatorBinding({
        url: options.facilitator.url,
        auth: options.facilitator.auth,
      });
      binding = remoteBinding;
    }

    // health() reads the chain itself, with a timeout. Verification and
    // settlement go through the facilitator instead. Health details can reach
    // logs, so they name the RPC by origin.
    const base = {
      network: input.network as Network,
      assetDecimals: input.assetDecimals,
      rpcUrl: input.rpcUrl,
      rpcOrigin: describeRpc(input.rpcUrl),
      binding,
    };
    if (profile.family === 'svm') {
      return { ...base, family: 'svm', profile, asset: input.asset, payTo: input.payTo };
    }
    if (profile.family === 'near') {
      return { ...base, family: 'near', profile, asset: input.asset, payTo: input.payTo };
    }
    return {
      ...base,
      family: 'evm',
      profile,
      method: input.assetTransferMethod ?? 'eip3009',
      asset: input.asset as `0x${string}`,
      assetName: input.assetName,
      assetVersion: input.assetVersion,
      payTo: input.payTo as `0x${string}`,
      healthClient: createLocalPublicClient(input.rpcUrl, HEALTH_TIMEOUT_MS, profile.chainId),
    };
  });
  return { offers, deploymentMode: mode as DeploymentMode, remoteBinding };
}

/**
 * Uses the network's default token symbol when paying that asset; otherwise
 * uses the resource's currency, the gateway's only label for another token.
 */
export function offerCurrency(offer: Offer, quoted: string): string {
  const canonical = offer.profile.canonicalAsset;
  return canonical !== undefined && sameAddress(offer.profile, offer.asset, canonical.address)
    ? canonical.symbol
    : quoted;
}
