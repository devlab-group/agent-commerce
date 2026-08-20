import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  defaultInitAnswers,
  LOCAL_DEV_FACILITATOR_PRIVATE_KEY,
  LOCAL_DEV_MERCHANT_ADDRESS,
  renderInitConfigYaml,
} from '../../../src/cli/lib/init-config.js';
import { parseConfig } from '../../../src/config/index.js';
import { compileJsonSchema } from '../../../src/core/execution/index.js';
import { ANVIL_WELL_KNOWN_ACCOUNTS } from '../../../src/payments/x402/testing.js';

describe('dev account constants', () => {
  // A hand-copied or truncated literal breaks every paid request
  // (privateKeyToAccount rejects a 63-char key) and silently defeats the
  // dev-key guard (it stops matching the well-known-key set). Deriving
  // both constants from the canonical account list makes that divergence
  // impossible to reintroduce without this test failing.
  it('LOCAL_DEV_FACILITATOR_PRIVATE_KEY is exactly Anvil account #0 (the facilitator signer)', () => {
    expect(LOCAL_DEV_FACILITATOR_PRIVATE_KEY).toBe(ANVIL_WELL_KNOWN_ACCOUNTS[0].privateKey);
    expect(LOCAL_DEV_FACILITATOR_PRIVATE_KEY).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it('LOCAL_DEV_MERCHANT_ADDRESS is exactly Anvil account #1 (the merchant payTo)', () => {
    expect(LOCAL_DEV_MERCHANT_ADDRESS).toBe(ANVIL_WELL_KNOWN_ACCOUNTS[1].address);
  });

  it('the facilitator key and merchant address are not the same account (would resettle to self)', () => {
    expect(LOCAL_DEV_FACILITATOR_PRIVATE_KEY).not.toBe(ANVIL_WELL_KNOWN_ACCOUNTS[1].privateKey);
  });
});

describe('renderInitConfigYaml', () => {
  it('renders YAML that parseConfig() accepts for the default answers', () => {
    const yamlText = renderInitConfigYaml(defaultInitAnswers());
    const raw = parseYaml(yamlText);
    const config = parseConfig(raw, {});
    expect(config.resources).toHaveLength(2);
    expect(config.resources.map((r) => r.id).sort()).toEqual(['report', 'weather']);
    expect(config.payments.x402?.enabled).toBe(true);
    expect(config.payments.x402?.payTo).toBe(LOCAL_DEV_MERCHANT_ADDRESS);
  });

  it('includes only the selected resources', () => {
    const yamlText = renderInitConfigYaml({
      backendBaseUrl: 'http://localhost:3000',
      resources: ['weather'],
      protocols: ['http', 'mcp'],
      x402Enabled: true,
      merchantPayTo: LOCAL_DEV_MERCHANT_ADDRESS,
    });
    const config = parseConfig(parseYaml(yamlText), {});
    expect(config.resources.map((r) => r.id)).toEqual(['weather']);
  });

  it('omits payments.x402 entirely when x402 is disabled, and marks report free', () => {
    const yamlText = renderInitConfigYaml({
      backendBaseUrl: 'http://localhost:3000',
      resources: ['report'],
      protocols: ['http'],
      x402Enabled: false,
      merchantPayTo: LOCAL_DEV_MERCHANT_ADDRESS,
    });
    const config = parseConfig(parseYaml(yamlText), {});
    expect(config.payments.x402).toBeUndefined();
    const report = config.resources.find((r) => r.id === 'report');
    expect(report?.pricing).toEqual({ type: 'free' });
    expect(report?.paymentMethods).toEqual([]);
  });

  it('marks report as fixed-price with the x402 payment method when x402 is enabled', () => {
    const yamlText = renderInitConfigYaml({
      backendBaseUrl: 'http://localhost:3000',
      resources: ['report'],
      protocols: ['http'],
      x402Enabled: true,
      merchantPayTo: LOCAL_DEV_MERCHANT_ADDRESS,
    });
    const config = parseConfig(parseYaml(yamlText), {});
    const report = config.resources.find((r) => r.id === 'report');
    expect(report?.pricing).toEqual({ type: 'fixed', amount: '0.01', currency: 'USDC' });
    expect(report?.paymentMethods).toEqual(['x402']);
  });

  it('respects the chosen protocol set for exposedVia', () => {
    const yamlText = renderInitConfigYaml({
      backendBaseUrl: 'http://localhost:3000',
      resources: ['weather'],
      protocols: ['mcp'],
      x402Enabled: false,
      merchantPayTo: LOCAL_DEV_MERCHANT_ADDRESS,
    });
    const config = parseConfig(parseYaml(yamlText), {});
    expect(config.protocols.http.enabled).toBe(false);
    expect(config.protocols.mcp.enabled).toBe(true);
    expect(config.resources[0]?.exposedVia).toEqual(['mcp']);
  });

  it('templates the backend base URL into each resource handler', () => {
    const yamlText = renderInitConfigYaml({
      backendBaseUrl: 'http://my-backend:9000',
      resources: ['weather', 'report'],
      protocols: ['http', 'mcp'],
      x402Enabled: true,
      merchantPayTo: LOCAL_DEV_MERCHANT_ADDRESS,
    });
    const config = parseConfig(parseYaml(yamlText), {});
    const weather = config.resources.find((r) => r.id === 'weather');
    const report = config.resources.find((r) => r.id === 'report');
    expect(weather?.handler.url).toBe('http://my-backend:9000/api/weather/{city}');
    expect(report?.handler.url).toBe('http://my-backend:9000/api/report');
  });

  it('includes the generated-by header comment', () => {
    const yamlText = renderInitConfigYaml(defaultInitAnswers());
    expect(yamlText).toMatch(/^# Generated by `agent-commerce init`\./);
  });

  // A config binding every interface with no token, combined with an
  // unrelated access-control bug, is what makes an unauthenticated ledger
  // read reachable from the network rather than only from localhost. Defaults should not depend on another
  // control being correct.
  it('binds the gateway to loopback, not every interface', () => {
    const config = parseConfig(parseYaml(renderInitConfigYaml(defaultInitAnswers())), {});
    expect(config.server.host).toBe('127.0.0.1');
  });

  it('does not generate a real adminToken, but the header explains how to add one', () => {
    const yamlText = renderInitConfigYaml(defaultInitAnswers());
    const config = parseConfig(parseYaml(yamlText), {});
    expect(config.server.adminToken).toBeUndefined();
    expect(yamlText).toContain('adminToken');
    expect(yamlText).toContain('allowedOrigins');
    expect(yamlText).toMatch(/\/api\/receipts/);
    expect(yamlText).toContain('SECURITY.md');
  });

  //(CLI half): a generated resource without
  // `additionalProperties: false` — or with no `input` schema at all, which
  // `compileJsonSchema(undefined)` treats as "accept anything" — forwards
  // arbitrary caller-chosen keys straight to the merchant backend. Both
  // generated resources must reject a key the schema never declared, using
  // the real validator every resource is actually checked against.
  describe('generated resource schemas reject unexpected input keys', () => {
    it('weather: rejects an extra key alongside the declared "city"', () => {
      const config = parseConfig(parseYaml(renderInitConfigYaml(defaultInitAnswers())), {});
      const weather = config.resources.find((r) => r.id === 'weather');
      const validate = compileJsonSchema(weather?.inputSchema);
      expect(validate({ city: 'Berlin' })).toMatchObject({ valid: true });
      expect(validate({ city: 'Berlin', evil: true })).toMatchObject({ valid: false });
    });

    it('report: has an explicit closed schema and rejects any input key', () => {
      const config = parseConfig(parseYaml(renderInitConfigYaml(defaultInitAnswers())), {});
      const report = config.resources.find((r) => r.id === 'report');
      expect(report?.inputSchema).toBeDefined();
      const validate = compileJsonSchema(report?.inputSchema);
      expect(validate({})).toMatchObject({ valid: true });
      expect(validate({ apikey: 'attacker' })).toMatchObject({ valid: false });
    });
  });
});
