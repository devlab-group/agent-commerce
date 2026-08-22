/**
 * Prevents a well-known Anvil development private key — or a well-known
 * Anvil development *address* — from ever being used against anything other
 * than a loopback/private/dev RPC. Two symmetric mistakes, both covered:
 * signing settlement with a dev key (`assertDevKeyIsLocalOnly`), and routing
 * settlement revenue to a dev address (`assertPayToIsNotDevAddress`). The
 * second is the more consequential of the two — a wrong key merely fails to
 * sign, a wrong payTo silently succeeds and gives the money away, since the
 * private key behind every well-known Anvil address is public (see in
 * the.
 *
 * Chain id alone cannot tell a real network from this project's local dev
 * chain: Base Sepolia's own chain id is 84532, the same id this project
 * deliberately reuses for the local chain so the unmodified x402 SDK can talk
 * to it. A dev key or dev payTo pointed at a real RPC by a config mistake is
 * instantly drainable — this is checked once at provider construction, not per
 * payment.
 */
import { CommerceError } from '../../core/index.js';
import { ANVIL_WELL_KNOWN_ACCOUNTS } from './local-chain/accounts.js';

const WELL_KNOWN_DEV_KEYS: ReadonlySet<string> = new Set(
  ANVIL_WELL_KNOWN_ACCOUNTS.map((a) => a.privateKey.toLowerCase()),
);

const WELL_KNOWN_DEV_ADDRESSES: ReadonlySet<string> = new Set(
  ANVIL_WELL_KNOWN_ACCOUNTS.map((a) => a.address.toLowerCase()),
);

/** `0x` + 64 hex chars — the only shape `privateKeyToAccount` accepts. */
const PRIVATE_KEY_SHAPE = /^0x[0-9a-fA-F]{64}$/;

export function isWellKnownDevKey(privateKey: string): boolean {
  return WELL_KNOWN_DEV_KEYS.has(privateKey.toLowerCase());
}

export function isWellKnownDevAddress(address: string): boolean {
  return WELL_KNOWN_DEV_ADDRESSES.has(address.toLowerCase());
}

/**
 * True for loopback addresses, RFC1918 private ranges, and bare (dot-free)
 * hostnames — the shape of a docker-compose/k8s service name (e.g.
 * "anvil"), which a real public DNS name essentially never has.
 *
 * ASSUMPTION (the loosest edge of this guard, named explicitly per external
 *: every dot-free, colon-free hostname is treated as
 * private, with no exceptions. A single-label *public* hostname (no dots) is
 * essentially nonexistent in practice — ICANN does not delegate bare
 * gTLDs/TLDs as public A/AAAA records — but this function cannot tell "no
 * dots because it's a compose service name" from "no dots because it's an
 * unusual real host" if one somehow existed. If that assumption ever stops
 * holding, this is the line to revisit.
 */
export function isLikelyLocalOrPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
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
    throw new CommerceError(
      'CONFIG_INVALID',
      `x402 provider: rpcUrl "${rpcUrl}" is not a valid URL`,
      { cause },
    );
  }
}

/**
 * Throws CONFIG_INVALID if a well-known dev key would sign against a non-local
 * RPC — or if `signerPrivateKey` isn't shaped like a private key at all.
 *
 * The shape check runs first and unconditionally. "Not a key I recognise"
 * (falls through `isWellKnownDevKey`, silently treated as someone's own real
 * facilitator key) and "not a key at all" (e.g. a truncated 63-char string)
 * must never share a code path: a malformed key that slips past this guard
 * only fails later, inside `settle()`, after the buyer's replayKey is already
 * reserved (see in the.
 */
export function assertDevKeyIsLocalOnly(rpcUrl: string, signerPrivateKey: string): void {
  if (!PRIVATE_KEY_SHAPE.test(signerPrivateKey)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      'x402 provider: facilitator.signerPrivateKey is not a well-formed private key ' +
        '(expected "0x" followed by exactly 64 hex characters).',
    );
  }

  if (!isWellKnownDevKey(signerPrivateKey)) return; // a real facilitator key: not our business

  const hostname = parseHostnameOrThrow(rpcUrl);

  if (!isLikelyLocalOrPrivateHost(hostname)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      'x402 provider: facilitator.signerPrivateKey is a well-known Anvil development key, but rpcUrl ' +
        `"${rpcUrl}" does not look like a local/private chain. A public dev key must never sign against ` +
        'a public network — it is instantly drainable and can grief real settlements via nonce exhaustion. ' +
        'Use a real facilitator key for any non-local RPC, or point rpcUrl at your local/dev chain.',
    );
  }
}

/**
 * Throws CONFIG_INVALID if `payTo` (the settlement destination) is a
 * well-known Anvil development address and `rpcUrl` doesn't look
 * local/private.
 *
 * Mirrors `assertDevKeyIsLocalOnly`, but guards the *receiving* side of the
 * payment instead of the signing side, and — unlike the key guard — applies
 * regardless of facilitator mode: which account signs the settlement
 * transaction has no bearing on whether the destination address is one whose
 * private key is public knowledge. `agent-commerce init` defaults `payTo` to
 * a well-known Anvil address as a local-demo convenience; on a real network
 * that default routes every payment to an address anyone on earth can sweep.
 */
export function assertPayToIsNotDevAddress(rpcUrl: string, payTo: string): void {
  if (!isWellKnownDevAddress(payTo)) return; // not a dev address: not our business

  const hostname = parseHostnameOrThrow(rpcUrl);

  if (!isLikelyLocalOrPrivateHost(hostname)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `x402 provider: "payTo" (${payTo}) is a well-known Anvil development address, but rpcUrl ` +
        `"${rpcUrl}" does not look like a local/private chain. The private key behind that address ` +
        'is public knowledge, so any revenue settled to it is immediately spendable by anyone. Set ' +
        '"payTo" to your own merchant wallet for any non-local RPC, or point rpcUrl at your ' +
        'local/dev chain.',
    );
  }
}
