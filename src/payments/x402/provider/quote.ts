/**
 * Issues experimental ERC-8409 quotes when the provider enables `quote`.
 *
 * For requests that can be canonicalized, `extensions["erc-8409"]` carries
 * one quote per EVM offer: chain, token, payee and amount in base units.
 * A dedicated issuer key signs the terms and request hash with EIP-712.
 * Quotes are informational; verify() and settle() use the offer without
 * reading the quotes.
 */
import { randomBytes } from 'node:crypto';
import { type Hex, keccak256, stringToBytes } from 'viem';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { type Clock, CommerceError } from '../../../core';
import { canonicalJson } from '../../../core/canonical-json';
import { isWellKnownDevKey } from '../dev-key-guard';
import type { DeploymentMode } from '../networks';
import type { EvmOffer, Offer } from './types';

/** Key for quotes in `PaymentRequired.extensions` */
export const QUOTE_EXTENSION = 'erc-8409';

/**
 * Request scheme for Keccak-256 hashes of the RFC 8785 (JCS) serialization of
 * `{ "input": <input>, "resource": <resource id> }`. The input is the validated
 * resource input used to build the backend request. The resource ID identifies
 * the operation and also names the MCP tool and A2A skill.
 */
export const QUOTE_REQUEST_SCHEME = 'agent-commerce/request/v1';

/** The ERC's EIP-712 domain, with the chain ID added per quote */
export const QUOTE_DOMAIN = { name: 'Signed Service Payment Quotes', version: '1' } as const;

/** The ERC's EIP-712 type; field order is part of the type hash */
export const QUOTE_TYPES = {
  ServicePaymentQuote: [
    { name: 'issuer', type: 'address' },
    { name: 'payer', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'asset', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'requestScheme', type: 'string' },
    { name: 'requestHash', type: 'bytes32' },
    { name: 'quoteId', type: 'bytes32' },
    { name: 'validAfter', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
  ],
} as const;

// A zero payer makes a bearer quote; the payment signature identifies the payer
const BEARER = '0x0000000000000000000000000000000000000000';

// The JSON Schema x402 v2 requires beside each extension's `info`
const QUOTE_INFO_SCHEMA = {
  type: 'object',
  required: ['quotes'],
  properties: {
    quotes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['chainId', 'quote', 'signature'],
        properties: {
          chainId: { type: 'string' },
          // Every field is a string in the ERC's JSON encoding
          quote: {
            type: 'object',
            required: QUOTE_TYPES.ServicePaymentQuote.map((field) => field.name),
            properties: Object.fromEntries(
              QUOTE_TYPES.ServicePaymentQuote.map((field) => [field.name, { type: 'string' }]),
            ),
          },
          signature: { type: 'string' },
        },
      },
    },
  },
} as const;

// Bound cache memory by evicting the oldest quote when the limit is reached
const QUOTE_CACHE_LIMIT = 1024;

/** A quote in the ERC's JSON format, with integers as decimal strings */
export interface SignedQuote {
  readonly chainId: string;
  readonly quote: {
    readonly issuer: Hex;
    readonly payer: Hex;
    readonly recipient: Hex;
    readonly asset: Hex;
    readonly amount: string;
    readonly requestScheme: string;
    readonly requestHash: Hex;
    readonly quoteId: Hex;
    readonly validAfter: string;
    readonly validUntil: string;
  };
  readonly signature: Hex;
}

/** An EVM challenge offer and its `accepts` amount in base units */
export interface QuotedOffer {
  readonly offer: EvmOffer;
  readonly amount: string;
}

export interface QuoteIssuer {
  readonly issuer: Hex;
  /**
   * Challenge extensions, or undefined when there are no EVM offers, input is
   * missing, or canonicalJson rejects the request
   */
  readonly extensionsFor: (
    resourceId: string,
    input: unknown,
    offers: readonly QuotedOffer[],
  ) => Promise<Record<string, unknown> | undefined>;
}

/**
 * Creates the issuer during provider construction. Rejects an invalid key,
 * a well-known Anvil key outside the local chain, a key matching an EVM
 * `payTo`, or a configuration without an EVM offer.
 */
export function createQuoteIssuer(options: {
  readonly signerPrivateKey: string;
  readonly offers: readonly Offer[];
  readonly deploymentMode: DeploymentMode;
  readonly clock: Clock;
  readonly maxTimeoutSeconds: number;
}): QuoteIssuer {
  const { signerPrivateKey, offers, deploymentMode, clock, maxTimeoutSeconds } = options;
  let account: PrivateKeyAccount;
  try {
    account = privateKeyToAccount(signerPrivateKey as Hex);
  } catch (cause) {
    throw new CommerceError(
      'CONFIG_INVALID',
      'x402 provider: quote.signerPrivateKey is not a valid private key (expected "0x" followed by 64 hex characters)',
      { cause },
    );
  }
  if (deploymentMode !== 'local' && isWellKnownDevKey(signerPrivateKey)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      'x402 provider: quote.signerPrivateKey is a well-known Anvil development key, so anyone could sign quotes as this gateway. Use a dedicated key outside the local chain.',
    );
  }
  const evmOffers = offers.filter((offer): offer is EvmOffer => offer.family === 'evm');
  if (evmOffers.length === 0) {
    throw new CommerceError(
      'CONFIG_INVALID',
      'x402 provider: quote needs an EVM offer; ERC-8409 quotes cover EVM networks only',
    );
  }
  const issuer = account.address;
  if (evmOffers.some((offer) => offer.payTo.toLowerCase() === issuer.toLowerCase())) {
    throw new CommerceError(
      'CONFIG_INVALID',
      'x402 provider: quote.signerPrivateKey controls a payTo address. Use a dedicated key, not the merchant wallet.',
    );
  }

  const cache = new Map<string, SignedQuote>();

  async function quoteFor(offer: EvmOffer, amount: string, requestHash: Hex): Promise<SignedQuote> {
    const now = Math.floor(clock.now().getTime() / 1000);
    const { chainId } = offer.profile;
    const key = [
      chainId,
      offer.payTo.toLowerCase(),
      offer.asset.toLowerCase(),
      amount,
      requestHash,
    ].join('|');
    const cached = cache.get(key);
    // Reuse a cached quote while a full payment window remains to avoid
    // signing retries; a cache miss requires a new signature
    if (cached !== undefined && Number(cached.quote.validUntil) - now >= maxTimeoutSeconds) {
      return cached;
    }
    const validUntil = now + 2 * maxTimeoutSeconds;
    const quote = {
      issuer,
      payer: BEARER,
      recipient: offer.payTo,
      asset: offer.asset,
      amount,
      requestScheme: QUOTE_REQUEST_SCHEME,
      requestHash,
      // Use a new ID for each signed body, as the ERC requires
      quoteId: `0x${randomBytes(32).toString('hex')}`,
      validAfter: String(now),
      validUntil: String(validUntil),
    } as const;
    const signature = await account.signTypedData({
      domain: { ...QUOTE_DOMAIN, chainId },
      types: QUOTE_TYPES,
      primaryType: 'ServicePaymentQuote',
      message: {
        ...quote,
        amount: BigInt(amount),
        validAfter: BigInt(now),
        validUntil: BigInt(validUntil),
      },
    });
    const signed: SignedQuote = { chainId: String(chainId), quote, signature };
    cache.delete(key);
    if (cache.size >= QUOTE_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, signed);
    return signed;
  }

  return {
    issuer,
    async extensionsFor(resourceId, input, quoted) {
      if (quoted.length === 0) return undefined;
      // Missing or non-canonicalizable input still gets a payment challenge
      // without quotes
      const requestHash = quoteRequestHash(resourceId, input);
      if (requestHash === undefined) return undefined;
      const quotes: SignedQuote[] = [];
      for (const { offer, amount } of quoted) {
        quotes.push(await quoteFor(offer, amount, requestHash));
      }
      return { [QUOTE_EXTENSION]: { info: { quotes }, schema: QUOTE_INFO_SCHEMA } };
    },
  };
}

/** Hash under {@link QUOTE_REQUEST_SCHEME}, or undefined when canonicalJson rejects the request */
export function quoteRequestHash(resourceId: string, input: unknown): Hex | undefined {
  const canonical = canonicalJson({ input, resource: resourceId });
  return canonical === undefined ? undefined : keccak256(stringToBytes(canonical));
}
