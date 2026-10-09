// The MPP rail's settings
import { CommerceError } from '../../core';
import {
  isMppNetwork,
  MPP_DEFAULT_NETWORK,
  MPP_DEFAULT_PAYMENT_FLOW,
  MPP_MIN_CHALLENGE_SECRET_LENGTH,
  MPP_NETWORKS,
} from '../../payments/mpp/constants';
import { resolveX402Deployment } from '../../payments/x402/guardrails';
import type { RawConfig } from './raw';
import type { GatewayConfig } from './types';
import { toBoolean, toNumber, validateAddress } from './values';
import { normalizeFacilitator } from './x402';

export type NormalizedMpp = NonNullable<GatewayConfig['payments']['mpp']>;

export function normalizeMpp(raw: RawConfig['payments']['mpp']): NormalizedMpp | undefined {
  if (raw === undefined) return undefined;
  const network = raw.network ?? MPP_DEFAULT_NETWORK;
  if (!isMppNetwork(network)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `payments.mpp.network must be one of ${MPP_NETWORKS.join(', ')}`,
      { details: { path: 'payments.mpp.network' } },
    );
  }
  const mpp: NormalizedMpp = {
    enabled: toBoolean(raw.enabled, 'payments.mpp.enabled'),
    network,
    rpcUrl: raw.rpcUrl,
    asset: raw.asset,
    assetName: raw.assetName,
    assetVersion: raw.assetVersion,
    recipient: raw.recipient,
    realm: raw.realm,
    challengeSecret: raw.challengeSecret,
    ...(raw.challengeTtlSeconds !== undefined
      ? {
          challengeTtlSeconds: toNumber(
            raw.challengeTtlSeconds,
            'payments.mpp.challengeTtlSeconds',
            { min: 1 },
          ),
        }
      : {}),
    paymentFlow: raw.paymentFlow ?? MPP_DEFAULT_PAYMENT_FLOW,
    facilitator: normalizeFacilitator(raw.facilitator),
    ...(raw.allowMainnet !== undefined
      ? { allowMainnet: toBoolean(raw.allowMainnet, 'payments.mpp.allowMainnet') }
      : {}),
    ...(raw.allowUnauthenticatedFacilitator !== undefined
      ? {
          allowUnauthenticatedFacilitator: toBoolean(
            raw.allowUnauthenticatedFacilitator,
            'payments.mpp.allowUnauthenticatedFacilitator',
          ),
        }
      : {}),
  };
  validateAddress('payments.mpp.recipient', mpp.recipient);
  validateAddress('payments.mpp.asset', mpp.asset);
  // mppx refuses CR or LF in a quoted challenge parameter
  if (/[\r\n]/.test(mpp.realm)) {
    throw new CommerceError('CONFIG_INVALID', 'payments.mpp.realm must be a single line', {
      details: { path: 'payments.mpp.realm' },
    });
  }
  // Length only: the secret itself never appears in an error
  if (mpp.challengeSecret.length < MPP_MIN_CHALLENGE_SECRET_LENGTH) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `payments.mpp.challengeSecret must have length at least ${MPP_MIN_CHALLENGE_SECRET_LENGTH}`,
      { details: { path: 'payments.mpp.challengeSecret' } },
    );
  }
  // The shared x402 address, facilitator and mainnet guards, reported under the
  // MPP config path
  resolveX402Deployment({
    network: mpp.network,
    payTo: mpp.recipient,
    asset: mpp.asset,
    assetName: mpp.assetName,
    assetVersion: mpp.assetVersion,
    facilitator: mpp.facilitator,
    ...(mpp.allowMainnet !== undefined ? { allowMainnet: mpp.allowMainnet } : {}),
    ...(mpp.allowUnauthenticatedFacilitator !== undefined
      ? { allowUnauthenticatedFacilitator: mpp.allowUnauthenticatedFacilitator }
      : {}),
    configPath: 'payments.mpp',
    payToField: 'recipient',
  });
  return mpp;
}
