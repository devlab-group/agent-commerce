/**
 * Canonical `CommerceResource` fixtures used by the MCP conformance suite.
 * These are plain data — no gateway, no config loader, no payment provider.
 */
import type { CommerceResource } from '../../../src/core/index.js';

/** Free resource, exposed via both mcp and http. */
export const FREE_ECHO_RESOURCE: CommerceResource = {
  id: 'echo',
  name: 'Echo',
  description: 'Echoes the supplied message back.',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Message to echo back.' },
    },
    required: ['message'],
  },
  handler: { type: 'http', method: 'POST', url: 'http://127.0.0.1:9/echo' },
  pricing: { type: 'free' },
  exposedVia: ['mcp', 'http'],
  paymentMethods: [],
};

/** Paid (fixed-price) resource, exposed via mcp. */
export const PAID_WEATHER_RESOURCE: CommerceResource = {
  id: 'get-weather',
  name: 'Get Weather',
  description: 'Returns the current weather for a city.',
  inputSchema: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name.' },
    },
    required: ['city'],
  },
  handler: { type: 'http', method: 'GET', url: 'http://127.0.0.1:9/weather' },
  pricing: { type: 'fixed', amount: '0.05', currency: 'USDC' },
  exposedVia: ['mcp', 'http'],
  paymentMethods: ['x402'],
};

/** Not exposed via mcp — must be absent from tools/list. */
export const HTTP_ONLY_RESOURCE: CommerceResource = {
  id: 'internal-report',
  name: 'Internal Report',
  description: 'HTTP-only resource, must not appear as an MCP tool.',
  handler: { type: 'http', method: 'GET', url: 'http://127.0.0.1:9/report' },
  pricing: { type: 'free' },
  exposedVia: ['http'],
  paymentMethods: [],
};

/** Id is not a legal MCP tool name (space and `!`) — must be skipped, not mangled. */
export const INVALID_ID_RESOURCE: CommerceResource = {
  id: 'bad tool id!',
  name: 'Bad Tool Id',
  description: 'Has a resource id that is not a legal MCP tool name.',
  handler: { type: 'http', method: 'GET', url: 'http://127.0.0.1:9/bad' },
  pricing: { type: 'free' },
  exposedVia: ['mcp'],
  paymentMethods: [],
};

/** No inputSchema at all — buildInputSchema must still produce a valid object schema. */
export const NO_SCHEMA_RESOURCE: CommerceResource = {
  id: 'ping',
  name: 'Ping',
  handler: { type: 'http', method: 'GET', url: 'http://127.0.0.1:9/ping' },
  pricing: { type: 'free' },
  exposedVia: ['mcp'],
  paymentMethods: [],
};

/**
 * Dynamic pricing exists in the type system for forward compatibility (config
 * validation rejects it in v0.1) — the adapter must still describe it as paid
 * without inventing an amount/currency it does not have.
 */
export const DYNAMIC_PRICED_RESOURCE: CommerceResource = {
  id: 'custom-quote',
  name: 'Custom Quote',
  description: 'Price depends on the request.',
  handler: { type: 'http', method: 'POST', url: 'http://127.0.0.1:9/quote' },
  pricing: { type: 'dynamic', resolver: 'quote-resolver' },
  exposedVia: ['mcp'],
  paymentMethods: ['x402'],
};

/**
 * Priced but declares no payment method at all — the adapter must not invent
 * one. A `_payment` proof supplied for this resource must be dropped, never
 * forwarded under a guessed rail.
 */
export const PAID_NO_METHOD_RESOURCE: CommerceResource = {
  id: 'no-method-paid',
  name: 'No Method Paid',
  description: 'Priced but has no configured payment method.',
  inputSchema: {
    type: 'object',
    properties: { q: { type: 'string', description: 'Query.' } },
  },
  handler: { type: 'http', method: 'GET', url: 'http://127.0.0.1:9/nomethod' },
  pricing: { type: 'fixed', amount: '1.00', currency: 'USDC' },
  exposedVia: ['mcp'],
  paymentMethods: [],
};
