/**
 * SDK-free Nano account addresses, for config load, the CLI and the provider.
 *
 * An address is `nano_` (or the legacy `xrb_`) followed by 52 base32
 * characters of the 32-byte public key and 8 of its checksum: BLAKE2b with a
 * 5-byte digest over the key, in reverse byte order. Node's `crypto` offers
 * BLAKE2b only with a 64-byte digest, and the digest length is a parameter of
 * the hash rather than a truncation, so the short BLAKE2b below (RFC 7693,
 * unkeyed) computes it.
 */

const ALPHABET = '13456789abcdefghijkmnopqrstuwxyz';
const ADDRESS =
  /^(?:nano|xrb)_([13][13456789abcdefghijkmnopqrstuwxyz]{51})([13456789abcdefghijkmnopqrstuwxyz]{8})$/;

/** The account's public key as 64 uppercase hex characters, or `undefined` */
export function nanoPublicKey(address: string): string | undefined {
  const match = ADDRESS.exec(address);
  if (!match) return undefined;
  const key = decodeBase32(match[1] as string);
  const checksum = decodeBase32(match[2] as string);
  const hex = key.toString(16).padStart(64, '0');
  const digest = blake2b(Buffer.from(hex, 'hex'), 5).reverse();
  return BigInt(`0x${Buffer.from(digest).toString('hex')}`) === checksum
    ? hex.toUpperCase()
    : undefined;
}

/** The `nano_` form of a valid address, or `undefined` */
export function normalizeNanoAddress(address: string): string | undefined {
  return nanoPublicKey(address) === undefined ? undefined : `nano_${address.split('_')[1]}`;
}

/** The address of a 32-byte public key given as 64 hex characters */
export function nanoAddressFromPublicKey(publicKeyHex: string): string {
  const key = Buffer.from(publicKeyHex, 'hex');
  const checksum = Buffer.from(blake2b(key, 5).reverse());
  return `nano_${encodeBase32(BigInt(`0x${key.toString('hex')}`), 52)}${encodeBase32(
    BigInt(`0x${checksum.toString('hex')}`),
    8,
  )}`;
}

function decodeBase32(chars: string): bigint {
  let n = 0n;
  for (const char of chars) n = (n << 5n) | BigInt(ALPHABET.indexOf(char));
  return n;
}

function encodeBase32(n: bigint, length: number): string {
  let out = '';
  for (let i = length - 1; i >= 0; i--) out += ALPHABET[Number((n >> BigInt(i * 5)) & 31n)];
  return out;
}

const MASK = (1n << 64n) - 1n;
const IV = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
] as const;

const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & MASK;

/** Unkeyed BLAKE2b (RFC 7693) with a digest of `outLength` bytes, 1 to 64 */
export function blake2b(input: Uint8Array, outLength: number): Uint8Array {
  const h = [...IV];
  h[0] = (h[0] as bigint) ^ BigInt(0x01010000 ^ outLength);
  const blocks = Math.max(1, Math.ceil(input.length / 128));
  for (let b = 0; b < blocks; b++) {
    const block = new Uint8Array(128);
    block.set(input.subarray(b * 128, (b + 1) * 128));
    const last = b === blocks - 1;
    const view = new DataView(block.buffer);
    const m = Array.from({ length: 16 }, (_, i) => view.getBigUint64(i * 8, true));
    const v = [...h, ...IV];
    const t = BigInt(last ? input.length : (b + 1) * 128);
    v[12] = (v[12] as bigint) ^ (t & MASK);
    v[13] = (v[13] as bigint) ^ (t >> 64n);
    if (last) v[14] = (v[14] as bigint) ^ MASK;
    const g = (a: number, bb: number, c: number, d: number, x: bigint, y: bigint) => {
      v[a] = ((v[a] as bigint) + (v[bb] as bigint) + x) & MASK;
      v[d] = rotr((v[d] as bigint) ^ (v[a] as bigint), 32n);
      v[c] = ((v[c] as bigint) + (v[d] as bigint)) & MASK;
      v[bb] = rotr((v[bb] as bigint) ^ (v[c] as bigint), 24n);
      v[a] = ((v[a] as bigint) + (v[bb] as bigint) + y) & MASK;
      v[d] = rotr((v[d] as bigint) ^ (v[a] as bigint), 16n);
      v[c] = ((v[c] as bigint) + (v[d] as bigint)) & MASK;
      v[bb] = rotr((v[bb] as bigint) ^ (v[c] as bigint), 63n);
    };
    for (let r = 0; r < 12; r++) {
      const s = SIGMA[r % 10] as readonly number[];
      const x = (i: number) => m[s[i] as number] as bigint;
      g(0, 4, 8, 12, x(0), x(1));
      g(1, 5, 9, 13, x(2), x(3));
      g(2, 6, 10, 14, x(4), x(5));
      g(3, 7, 11, 15, x(6), x(7));
      g(0, 5, 10, 15, x(8), x(9));
      g(1, 6, 11, 12, x(10), x(11));
      g(2, 7, 8, 13, x(12), x(13));
      g(3, 4, 9, 14, x(14), x(15));
    }
    for (let i = 0; i < 8; i++) {
      h[i] = (h[i] as bigint) ^ (v[i] as bigint) ^ (v[i + 8] as bigint);
    }
  }
  const out = new Uint8Array(64);
  const view = new DataView(out.buffer);
  h.forEach((word, i) => {
    view.setBigUint64(i * 8, word, true);
  });
  return out.slice(0, outLength);
}
