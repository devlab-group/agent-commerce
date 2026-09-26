/**
 * Rejects well-known Anvil keys and payment destinations when the RPC host
 * does not look local or private. Their private keys are published, so anyone
 * can spend what such an address receives on a public chain.
 *
 * The check uses the RPC hostname because the local chain shares Base
 * Sepolia's chain id. Both guards run at provider construction.
 */
import { CommerceError } from '../../core';
import { ANVIL_WELL_KNOWN_ACCOUNTS } from './local-chain/accounts';

const WELL_KNOWN_DEV_KEYS: ReadonlySet<string> = new Set(
  ANVIL_WELL_KNOWN_ACCOUNTS.map((a) => a.privateKey.toLowerCase()),
);

const WELL_KNOWN_DEV_ADDRESSES: ReadonlySet<string> = new Set(
  ANVIL_WELL_KNOWN_ACCOUNTS.map((a) => a.address.toLowerCase()),
);

// `0x` plus 64 hex characters, the only shape `privateKeyToAccount` accepts
const PRIVATE_KEY_SHAPE = /^0x[0-9a-fA-F]{64}$/;

export function isWellKnownDevKey(privateKey: string): boolean {
  return WELL_KNOWN_DEV_KEYS.has(privateKey.toLowerCase());
}

export function isWellKnownDevAddress(address: string): boolean {
  return WELL_KNOWN_DEV_ADDRESSES.has(address.toLowerCase());
}

/**
 * True for loopback addresses, RFC 1918 private ranges, and bare (dot-free)
 * hostnames, such as the compose service name "anvil".
 *
 * Bare hostnames are treated as local without resolving them. Operators must
 * point them at a private chain.
 */
export function isLikelyLocalOrPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (!h.includes('.') && !h.includes(':')) return true; // bare hostname
  return false;
}

function parseHostnameOrThrow(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).hostname;
  } catch (cause) {
    // Never the URL itself: RPC providers commonly put an API key in the path,
    // and this message reaches startup output and CI logs
    throw new CommerceError('CONFIG_INVALID', 'x402 provider: rpcUrl is not a valid URL', {
      cause,
    });
  }
}

/** Origin only, for diagnostics: RPC URLs often carry an API key in the path or query */
export function describeRpc(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).origin;
  } catch {
    return '[unparseable rpcUrl]';
  }
}

/**
 * Throws CONFIG_INVALID if `signerPrivateKey` is not shaped like a private key,
 * or if it is a well-known dev key and the RPC is not local.
 *
 * The shape check runs first, so a truncated key is reported as malformed
 * instead of passing as "not a dev key".
 */
export function assertDevKeyIsLocalOnly(rpcUrl: string, signerPrivateKey: string): void {
  if (!PRIVATE_KEY_SHAPE.test(signerPrivateKey)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      'x402 provider: facilitator.signerPrivateKey is not a well-formed private key ' +
        '(expected "0x" followed by exactly 64 hex characters).',
    );
  }

  if (!isWellKnownDevKey(signerPrivateKey)) return; // the operator's own key

  const hostname = parseHostnameOrThrow(rpcUrl);

  if (!isLikelyLocalOrPrivateHost(hostname)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      'x402 provider: facilitator.signerPrivateKey is a well-known Anvil development key, but rpcUrl ' +
        `${describeRpc(rpcUrl)} does not look like a local/private chain. A public dev key must never sign against ` +
        'a public network: it is instantly drainable and can grief real settlements via nonce exhaustion. ' +
        'Use a real facilitator key for any non-local RPC, or point rpcUrl at your local/dev chain.',
    );
  }
}

/**
 * Throws CONFIG_INVALID if `payTo` is a well-known Anvil address and `rpcUrl`
 * does not look local or private.
 *
 * Guards the receiving side, in every facilitator mode. `agent-commerce init`
 * defaults `payTo` to a well-known address for the local demo, and on a real
 * network that default sends every payment where anyone can sweep it.
 */
export function assertPayToIsNotDevAddress(rpcUrl: string, payTo: string): void {
  if (!isWellKnownDevAddress(payTo)) return;

  const hostname = parseHostnameOrThrow(rpcUrl);

  if (!isLikelyLocalOrPrivateHost(hostname)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `x402 provider: "payTo" (${payTo}) is a well-known Anvil development address, but rpcUrl ` +
        `${describeRpc(rpcUrl)} does not look like a local/private chain. The private key behind that address ` +
        'is public knowledge, so any revenue settled to it is immediately spendable by anyone. Set ' +
        '"payTo" to your own merchant wallet for any non-local RPC, or point rpcUrl at your ' +
        'local/dev chain.',
    );
  }
}
