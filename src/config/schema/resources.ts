// Resources: exposure, pricing, payment rails and backend handler
import type { Ap2AuthorizationConfig } from '../../authorization/ap2/types';
import {
  CommerceError,
  type CommerceResource,
  PAYMENT_METHOD_NAMES,
  PROTOCOL_NAMES,
  type Pricing,
  RESERVED_INPUT_FIELDS,
} from '../../core';
import { MPP_PROFILE } from '../../payments/mpp/constants';
import { MCP_TOOL_NAME_PATTERN } from '../../protocols/mcp/constants';
import { normalizeResourceAuthorization } from './ap2';
import {
  validateBackendHeaders,
  validateBackendUrl,
  validateInputBindings,
  validatePathParametersDeclared,
} from './backend';
import type { NormalizedMpp } from './mpp';
import type { RawResourceEntry } from './raw';
import {
  defaultClosedObjectSchema,
  EMPTY_CLOSED_OBJECT_SCHEMA,
  validateResourceSchemaKeywords,
} from './resource-schema';
import type { NormalizedProtocols } from './types';
import { toNumber } from './values';
import type { NormalizedX402 } from './x402';

const SUPPORTED_PROTOCOLS: ReadonlySet<string> = new Set(PROTOCOL_NAMES);

const SUPPORTED_PAYMENT_METHODS: ReadonlySet<string> = new Set(PAYMENT_METHOD_NAMES);

export function normalizeResource(
  id: string,
  entry: RawResourceEntry,
  protocols: NormalizedProtocols,
  x402: NormalizedX402 | undefined,
  mpp: NormalizedMpp | undefined,
  ap2: Ap2AuthorizationConfig | undefined,
): CommerceResource {
  if (entry.input !== undefined) validateResourceSchemaKeywords(id, 'input', entry.input);

  const inputProperties = entry.input?.['properties'];
  if (inputProperties && typeof inputProperties === 'object') {
    for (const reserved of RESERVED_INPUT_FIELDS) {
      if (!(reserved in inputProperties)) continue;
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" declares an input property "${reserved}", which is reserved by the gateway`,
        {
          details: {
            path: `resources.${id}.input.properties.${reserved}`,
            resourceId: id,
          },
        },
      );
    }
  }

  for (const protocol of entry.expose) {
    if (!SUPPORTED_PROTOCOLS.has(protocol)) {
      const hint = protocol === 'ucp' ? ' (UCP is planned, not supported in this release)' : '';
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" exposes unsupported protocol "${protocol}"${hint}. Supported: ${PROTOCOL_NAMES.join(', ')}.`,
        { details: { path: `resources.${id}.expose`, resourceId: id, protocol } },
      );
    }
  }
  if (entry.expose.includes('mcp')) {
    if (!protocols.mcp.enabled) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" is exposed via "mcp" but protocols.mcp.enabled is false`,
        { details: { path: `resources.${id}.expose`, resourceId: id } },
      );
    }
    if (!MCP_TOOL_NAME_PATTERN.test(id)) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" is exposed via "mcp" but its id is not a legal MCP tool name (allowed: A-Z, a-z, 0-9, "_", "-", ".", 1-128 chars)`,
        { details: { path: `resources.${id}`, resourceId: id } },
      );
    }
  }
  if (entry.expose.includes('a2a') && !protocols.a2a.enabled) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" is exposed via "a2a" but protocols.a2a.enabled is false`,
      { details: { path: `resources.${id}.expose`, resourceId: id } },
    );
  }
  if (entry.expose.includes('acp') && !protocols.acp.enabled) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" is exposed via "acp" but protocols.acp.enabled is false`,
      { details: { path: `resources.${id}.expose`, resourceId: id } },
    );
  }
  if (entry.expose.includes('http') && !protocols.http.enabled) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" is exposed via "http" but protocols.http.enabled is false`,
      { details: { path: `resources.${id}.expose`, resourceId: id } },
    );
  }

  validateBackendUrl(id, entry.backend.url);
  validateBackendHeaders(id, entry.backend.headers);
  const pathScope = validateInputBindings(id, entry.backend, entry.input);
  validatePathParametersDeclared(id, entry.backend.url, pathScope.schema, pathScope.where);

  if (entry.pricing.type === 'dynamic') {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" uses pricing.type "dynamic", which is not supported in this release`,
      { details: { path: `resources.${id}.pricing.type`, resourceId: id } },
    );
  }

  const paymentMethods = entry.payments ?? [];

  if (entry.x402 !== undefined) {
    const at = `resources.${id}.x402`;
    if (x402 === undefined) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" sets x402.accepts, but payments.x402 is not configured`,
        { details: { path: at, resourceId: id } },
      );
    }
    if (entry.pricing.type !== 'fixed' || !paymentMethods.includes('x402')) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" sets x402.accepts, which requires fixed pricing and "x402" in payments`,
        { details: { path: at, resourceId: id } },
      );
    }
  }
  // The resource's own offers, or the rail's
  const offers = x402 !== undefined ? (x402.resources[id] ?? x402) : undefined;

  if (entry.pricing.type === 'fixed') {
    // An x402 price is charged in every option's token, so the coarsest one
    // bounds it. MPP checks its own token's decimals below.
    const decimals = paymentMethods.includes('x402')
      ? offers?.options.map((option) => option.assetDecimals)
      : undefined;
    validatePricingAmount(id, entry.pricing.amount, decimals && Math.min(...decimals));
  }

  if (entry.pricing.type === 'fixed') {
    if (paymentMethods.length === 0) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" has fixed pricing but declares no "payments" (a paid resource must name at least one payment method)`,
        { details: { path: `resources.${id}.payments`, resourceId: id } },
      );
    }
    for (const method of paymentMethods) {
      if (!SUPPORTED_PAYMENT_METHODS.has(method)) {
        throw new CommerceError(
          'CONFIG_INVALID',
          `Resource "${id}" names unsupported payment method "${method}". Supported: ${PAYMENT_METHOD_NAMES.join(', ')}.`,
          { details: { path: `resources.${id}.payments`, resourceId: id, method } },
        );
      }
    }
    // At least one named rail must be enabled, not every one. `runGateway`
    // checks again at composition as defense in depth.
    const enabledRails = [
      ...(x402?.config.enabled ? ['x402'] : []),
      ...(mpp?.enabled ? ['mpp'] : []),
    ];
    if (!paymentMethods.some((method) => enabledRails.includes(method))) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" names payment method(s) "${paymentMethods.join(', ')}", none of which is configured and enabled under "payments"`,
        { details: { path: `resources.${id}.payments`, resourceId: id, paymentMethods } },
      );
    }
    // An offer in the network's default stablecoin, named or not, charges the
    // price in that token, so the price must name that token or USD
    const symbols = offers?.defaultAssetSymbols ?? [];
    const currency = entry.pricing.currency;
    if (
      x402?.config.enabled &&
      symbols.length > 0 &&
      paymentMethods.includes('x402') &&
      currency !== 'USD' &&
      !(symbols.length === 1 && currency === symbols[0])
    ) {
      const tokens = symbols.join(' and ');
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" is priced in ${currency}, but x402 settles in ${tokens}, the default asset of its network. Price it in ${symbols.length === 1 ? `${tokens} or ` : ''}USD.`,
        { details: { path: `resources.${id}.pricing.currency`, resourceId: id } },
      );
    }
    // MPP fixes the currency label and decimal precision for every resource it serves
    if (mpp?.enabled && paymentMethods.includes('mpp')) {
      if (entry.pricing.currency !== MPP_PROFILE.assetSymbol) {
        throw new CommerceError(
          'CONFIG_INVALID',
          `Resource "${id}" is priced in ${entry.pricing.currency}, but MPP charges ${MPP_PROFILE.assetSymbol}`,
          { details: { path: `resources.${id}.pricing.currency`, resourceId: id } },
        );
      }
      validatePricingAmount(id, entry.pricing.amount, MPP_PROFILE.assetDecimals);
    }
  }

  if (
    entry.paymentFlow !== undefined &&
    (entry.pricing.type !== 'fixed' ||
      !paymentMethods.some((method) => method === 'x402' || method === 'mpp'))
  ) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" sets paymentFlow, which requires fixed pricing and "x402" or "mpp" in payments`,
      { details: { path: `resources.${id}.paymentFlow`, resourceId: id } },
    );
  }

  if (
    entry.mimeType !== undefined &&
    (entry.pricing.type !== 'fixed' || !paymentMethods.includes('x402'))
  ) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" sets mimeType, which requires fixed pricing and "x402" in payments`,
      { details: { path: `resources.${id}.mimeType`, resourceId: id } },
    );
  }

  const pricing: Pricing =
    entry.pricing.type === 'free'
      ? { type: 'free' }
      : { type: 'fixed', amount: entry.pricing.amount, currency: entry.pricing.currency };

  const authorization = normalizeResourceAuthorization(id, entry, pricing, ap2);

  return {
    id,
    name: entry.name,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    inputSchema:
      entry.input !== undefined
        ? defaultClosedObjectSchema(entry.input)
        : EMPTY_CLOSED_OBJECT_SCHEMA,
    ...(entry.output !== undefined ? { outputSchema: entry.output } : {}),
    handler: {
      type: 'http',
      method: entry.backend.method,
      url: entry.backend.url,
      ...(entry.backend.headers !== undefined ? { headers: entry.backend.headers } : {}),
      ...(entry.backend.timeoutMs !== undefined
        ? {
            timeoutMs: toNumber(entry.backend.timeoutMs, `resources.${id}.backend.timeoutMs`, {
              min: 1,
            }),
          }
        : {}),
      ...(entry.backend.inputBindings !== undefined
        ? { inputBindings: pickDefined(entry.backend.inputBindings) }
        : {}),
    },
    pricing,
    exposedVia: entry.expose as CommerceResource['exposedVia'],
    paymentMethods: paymentMethods as CommerceResource['paymentMethods'],
    ...(authorization !== undefined ? { authorization } : {}),
  };
}

// A plain decimal: no currency symbol, thousands separator, sign or exponent.
// "0,01", "$0.01", "1e-2" and "-1" would otherwise load and then fail every
// purchase.
const PRICING_AMOUNT_PATTERN = /^\d+(?:\.\d+)?$/;

const ZERO_AMOUNT_PATTERN = /^0(?:\.0+)?$/;

function validatePricingAmount(id: string, amount: string, decimals: number | undefined): void {
  const path = `resources.${id}.pricing.amount`;
  if (!PRICING_AMOUNT_PATTERN.test(amount)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" has pricing.amount "${amount}", which is not a plain positive decimal (no currency symbol, no thousands separator, no exponent - e.g. "0.01")`,
      { details: { path, resourceId: id } },
    );
  }
  if (ZERO_AMOUNT_PATTERN.test(amount)) {
    // A zero-priced paid resource would settle a zero-value transfer
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" has pricing.amount "0" - a paid resource cannot cost zero; use "pricing: { type: free }" instead`,
      { details: { path, resourceId: id } },
    );
  }
  if (decimals !== undefined) {
    const fractionalDigits = amount.includes('.') ? (amount.split('.')[1]?.length ?? 0) : 0;
    if (fractionalDigits > decimals) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" has pricing.amount "${amount}" with more precision (${fractionalDigits} fractional digits) than the configured asset supports (${decimals} decimals)`,
        { details: { path, resourceId: id } },
      );
    }
  }
}

// Strips absent optional keys so the result satisfies `exactOptionalPropertyTypes`
function pickDefined<T extends Record<string, string | undefined>>(
  value: T,
): { [K in keyof T]?: string } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: string;
  };
}
