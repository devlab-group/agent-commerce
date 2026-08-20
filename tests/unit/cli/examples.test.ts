/**
 * `examples/**` are documentation the moment they stop validating — this
 * guards against silent drift (e.g. a config schema change in `core`) the
 * same way `init-config.test.ts` guards the CLI's own generated config.
 * Each example's own README documents the exact commands to run it for
 * real against the local demo stack; this only checks the shape.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../../src/config/index.js';

const EXAMPLES_DIR = join(import.meta.dirname, '../../../examples');

const EXAMPLES = ['simple-paid-api', 'free-and-premium', 'paid-mcp-tool'] as const;

describe('examples/**/config.yaml', () => {
  it.each(EXAMPLES)('%s: validates against the real config loader with no environment', (name) => {
    const yamlText = readFileSync(join(EXAMPLES_DIR, name, 'config.yaml'), 'utf8');
    const config = parseConfig(parseYaml(yamlText), {});
    expect(config.resources.length).toBeGreaterThan(0);
  });

  it('simple-paid-api: HTTP only, one paid resource', () => {
    const yamlText = readFileSync(join(EXAMPLES_DIR, 'simple-paid-api/config.yaml'), 'utf8');
    const config = parseConfig(parseYaml(yamlText), {});
    expect(config.protocols.http.enabled).toBe(true);
    expect(config.protocols.mcp.enabled).toBe(false);
    expect(config.resources.map((r) => r.pricing.type)).toEqual(['fixed']);
  });

  it('free-and-premium: one free resource, one paid resource, both protocols', () => {
    const yamlText = readFileSync(join(EXAMPLES_DIR, 'free-and-premium/config.yaml'), 'utf8');
    const config = parseConfig(parseYaml(yamlText), {});
    expect(config.resources.map((r) => r.pricing.type).sort()).toEqual(['fixed', 'free']);
    for (const resource of config.resources) {
      expect([...resource.exposedVia].sort()).toEqual(['http', 'mcp']);
    }
  });

  it('paid-mcp-tool: MCP only, no HTTP protocol at all', () => {
    const yamlText = readFileSync(join(EXAMPLES_DIR, 'paid-mcp-tool/config.yaml'), 'utf8');
    const config = parseConfig(parseYaml(yamlText), {});
    expect(config.protocols.http.enabled).toBe(false);
    expect(config.protocols.mcp.enabled).toBe(true);
    expect(config.resources[0]?.exposedVia).toEqual(['mcp']);
  });
});
