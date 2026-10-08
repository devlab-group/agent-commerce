/**
 * SDK-free address checks for config load and the CLI. Preserve EVM and
 * case-sensitive Solana addresses; normalize TON to raw `workchain:hex`.
 */
import type { X402Network } from './networks';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_ZERO = /^0x0{40}$/i;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// A 32-byte key is 32 to 44 base58 characters
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// The all-zero key, which is the System Program and owns nothing recoverable
const SOLANA_ZERO = '11111111111111111111111111111111';
const EVM_TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
// A 64-byte Ed25519 signature is at most 88 base58 characters
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

const TON_RAW = /^(0|-1):[0-9a-fA-F]{64}$/;
const TON_FRIENDLY = /^[A-Za-z0-9+/_-]{48}$/;
const TON_TAG_BOUNCEABLE = 0x11;
const TON_TAG_NON_BOUNCEABLE = 0x51;
const TON_TAG_TESTNET_ONLY = 0x80;
const TON_ZERO_HASH = /^-?\d+:0{64}$/;

/**
 * The address in wire form, or `undefined` when the value is not an address of
 * the network's family. A TON address flagged testnet-only is refused on a
 * mainnet network.
 */
export function normalizeAddress(network: X402Network, value: string): string | undefined {
  switch (network.family) {
    case 'evm':
      return EVM_ADDRESS.test(value) ? value : undefined;
    case 'svm':
      return SOLANA_ADDRESS.test(value) && base58ByteLength(value) === 32 ? value : undefined;
    case 'tvm':
      return normalizeTonAddress(value, network.kind);
  }
}

/** An address funds cannot be recovered from: the zero address of its family */
export function isBurnAddress(network: X402Network, wireAddress: string): boolean {
  switch (network.family) {
    case 'evm':
      return EVM_ZERO.test(wireAddress);
    case 'svm':
      return wireAddress === SOLANA_ZERO;
    case 'tvm':
      return TON_ZERO_HASH.test(wireAddress);
  }
}

/** Compare EVM addresses case-insensitively and base58/raw TON addresses exactly */
export function sameAddress(network: X402Network, a: string, b: string): boolean {
  return network.family === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * A settlement reference in its family's form: an EVM transaction hash or a
 * Solana transaction signature. TON settlement is not built, so none passes.
 */
export function isTransactionReference(network: X402Network, value: string): boolean {
  switch (network.family) {
    case 'evm':
      return EVM_TRANSACTION_HASH.test(value);
    case 'svm':
      return SOLANA_SIGNATURE.test(value) && base58ByteLength(value) === 64;
    case 'tvm':
      return false;
  }
}

function base58ByteLength(value: string): number {
  let n = 0n;
  for (const char of value) n = n * 58n + BigInt(BASE58_ALPHABET.indexOf(char));
  // Each leading '1' encodes one leading zero byte
  const leadingZeros = value.length - value.replace(/^1+/, '').length;
  return leadingZeros + (n === 0n ? 0 : Math.ceil(n.toString(16).length / 2));
}

function normalizeTonAddress(value: string, kind: X402Network['kind']): string | undefined {
  if (TON_RAW.test(value)) return value.toLowerCase();
  if (!TON_FRIENDLY.test(value)) return undefined;

  // Node's base64 decoder reads the URL-safe alphabet too
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 36) return undefined;
  const crc = (bytes[34] as number) * 256 + (bytes[35] as number);
  if (crc16(bytes.subarray(0, 34)) !== crc) return undefined;

  const tag = bytes[0] as number;
  const testnetOnly = (tag & TON_TAG_TESTNET_ONLY) !== 0;
  const base = tag & ~TON_TAG_TESTNET_ONLY;
  if (base !== TON_TAG_BOUNCEABLE && base !== TON_TAG_NON_BOUNCEABLE) return undefined;
  if (testnetOnly && kind === 'mainnet') return undefined;

  const workchain = (bytes[1] as number) === 0xff ? -1 : (bytes[1] as number);
  if (workchain !== 0 && workchain !== -1) return undefined;
  return `${workchain}:${bytes.subarray(2, 34).toString('hex')}`;
}

// CRC-16/XMODEM, the checksum of a user-friendly TON address
function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}
