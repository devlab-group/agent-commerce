// Test journal digests against expected input hashes computed from literal canonical JSON
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CommerceResource, PaymentRequirement } from '../../../../src/core';
import { configDigest, inputDigest } from '../../../../src/core/execution/journal';
import { makeResource } from './helpers';

const sha256 = (text: string) =>
  `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

describe('inputDigest', () => {
  it('hashes the canonical JSON, so key order does not change it', () => {
    const expected = sha256('{"city":"Oslo","days":[1,2],"units":{"a":true,"z":null}}');
    expect(inputDigest({ city: 'Oslo', days: [1, 2], units: { a: true, z: null } })).toBe(expected);
    expect(inputDigest({ units: { z: null, a: true }, days: [1, 2], city: 'Oslo' })).toBe(expected);
  });

  it('is absent for input that is not I-JSON, such as a lone surrogate', () => {
    expect(inputDigest({ text: '\uD800' })).toBeUndefined();
    expect(inputDigest({ ['\uDC00']: 1 })).toBeUndefined();
  });

  it('hashes a valid surrogate pair', () => {
    expect(inputDigest({ text: '😀' })).toBe(sha256('{"text":"😀"}'));
  });
});

describe('configDigest', () => {
  const resource = makeResource({
    id: 'market_report',
    pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
    paymentMethods: ['x402'],
    handler: {
      type: 'http',
      method: 'POST',
      url: 'http://backend.local/report',
      headers: { authorization: 'Bearer merchant-secret' },
    },
  });
  const requirement: PaymentRequirement = {
    id: 'requirement-1',
    requestId: 'req-1',
    resourceId: 'market_report',
    provider: 'x402',
    amount: '0.01',
    currency: 'USDC',
    destination: '0xMERCHANT',
    network: 'eip155:84532',
    asset: '0xASSET',
    challenge: { provider: 'x402', version: '2', accepts: [] },
  };
  const digest = configDigest(resource, requirement);

  it('is a sha256 digest, stable for the same terms', () => {
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(configDigest({ ...resource }, { ...requirement })).toBe(digest);
  });

  it('still digests a config that JCS refuses, such as a resource id with a lone surrogate', () => {
    const odd = configDigest({ ...resource, id: 'report\uD800' }, requirement);
    expect(odd).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(odd).not.toBe(digest);
  });

  it('ignores the backend URL and headers, which can carry secrets', () => {
    const rotated: CommerceResource = {
      ...resource,
      handler: {
        ...resource.handler,
        url: 'http://other-backend.local/report',
        headers: { authorization: 'Bearer rotated-secret' },
      },
    };
    expect(configDigest(rotated, requirement)).toBe(digest);
  });

  it.each<[string, CommerceResource, PaymentRequirement]>([
    [
      'the price',
      { ...resource, pricing: { type: 'fixed', amount: '0.02', currency: 'USDC' } },
      requirement,
    ],
    ['the payment methods', { ...resource, paymentMethods: ['x402', 'mpp'] }, requirement],
    [
      'the required authorization',
      { ...resource, authorization: { required: ['ap2'] } },
      requirement,
    ],
    ['the destination', resource, { ...requirement, destination: '0xOTHER' }],
    ['the network', resource, { ...requirement, network: 'eip155:8453' }],
    ['the asset', resource, { ...requirement, asset: '0xOTHER' }],
    ['the provider', resource, { ...requirement, provider: 'mpp' }],
    ['the payment flow', resource, { ...requirement, metadata: { settleAfterBackend: true } }],
  ])('changes with %s', (_term, changedResource, changedRequirement) => {
    expect(configDigest(changedResource, changedRequirement)).not.toBe(digest);
  });
});
