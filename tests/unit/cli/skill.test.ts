// Check command names, options, config paths and YAML examples in the agent
// skill against the CLI and config schema. Assistant behavior and other prose
// claims need separate verification.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { buildProgram } from '../../../src/cli/program';
import { parseConfig } from '../../../src/config';
import { RawConfigSchema } from '../../../src/config/schema/raw';
import { createCapturingIo } from './fixtures';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const skillDir = join(root, 'skills', 'agent-commerce');
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const manifest = readJson<{ name: string; version: string; license: string }>(
  join(root, 'package.json'),
);

// Every markdown file an agent reads
const docs = [
  'SKILL.md',
  ...readdirSync(join(skillDir, 'references')).map((f) => `references/${f}`),
]
  .filter((file) => file.endsWith('.md'))
  .map((file) => ({ file, text: readFileSync(join(skillDir, file), 'utf8') }));
const skill = docs.find((doc) => doc.file === 'SKILL.md')?.text ?? '';
const asset = readFileSync(join(skillDir, 'assets', 'config.yaml'), 'utf8');

// Values for every ${VAR} the examples use without a default
const ENV: NodeJS.ProcessEnv = {
  MERCHANT_WALLET: '0x2222222222222222222222222222222222222222',
  MERCHANT_API_BASE_URL: 'http://localhost:3000',
  BACKEND_TOKEN: 'backend-token',
  GATEWAY_SHARED_SECRET: 'shared-secret',
  X402_FACILITATOR_URL: 'https://facilitator.example',
  X402_FACILITATOR_TOKEN: 'facilitator-token',
  X402_RPC_URL: 'https://rpc.example',
  CDP_API_KEY_ID: 'cdp-key-id',
  CDP_API_KEY_SECRET: 'cdp-key-secret',
  ADMIN_TOKEN: 'admin-token',
};

// Fenced blocks and inline code: what an agent copies and runs
const codeOf = (text: string): string =>
  [...text.matchAll(/```[a-z]*\n([\s\S]*?)```|`([^`\n]+)`/g)]
    .map((match) => match[1] ?? match[2])
    .join('\n');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// A fragment's leaves replace the template's; arrays are replaced whole
function merge(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = merge(base[key], value);
  return out;
}

// Every key path the config schema accepts, with `*` for a record key
function schemaPaths(schema: z.ZodTypeAny, prefix: string[] = [], out = new Set<string>()) {
  if (prefix.length > 8) return out;
  if (prefix.length > 0) out.add(prefix.join('.'));
  const def = schema._def as Record<string, unknown>;
  const inner = [def['innerType'], def['schema'], def['type'], def['in'], def['out']];
  if (schema instanceof z.ZodObject) {
    for (const [key, value] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
      schemaPaths(value, [...prefix, key], out);
    }
  } else if (schema instanceof z.ZodRecord) {
    schemaPaths(schema.valueSchema as z.ZodTypeAny, [...prefix, '*'], out);
  } else if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
    for (const option of schema.options as z.ZodTypeAny[]) schemaPaths(option, prefix, out);
  } else if (schema instanceof z.ZodIntersection) {
    schemaPaths(schema._def.left, prefix, out);
    schemaPaths(schema._def.right, prefix, out);
  } else if (schema instanceof z.ZodLazy) {
    schemaPaths(schema.schema, prefix, out);
  } else if (!(schema instanceof z.ZodArray)) {
    for (const next of inner) if (next instanceof z.ZodType) schemaPaths(next, prefix, out);
  }
  return out;
}

describe('agent skill', () => {
  it('uses only the Agent Skills frontmatter fields, within their limits', () => {
    const block = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1];
    const meta = parseYaml(block ?? '') as Record<string, unknown>;
    const allowed = [
      'name',
      'description',
      'license',
      'compatibility',
      'metadata',
      'allowed-tools',
    ];
    expect(Object.keys(meta).filter((key) => !allowed.includes(key))).toEqual([]);

    // The name must match its directory, which the plugin also uses
    expect(meta['name']).toBe('agent-commerce');
    expect(String(meta['name'])).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(String(meta['description']).length).toBeGreaterThan(0);
    expect(String(meta['description']).length).toBeLessThanOrEqual(1024);
    expect(String(meta['compatibility']).length).toBeLessThanOrEqual(500);
    expect(meta['license']).toBe(manifest.license);

    const metadata = meta['metadata'] as Record<string, unknown>;
    expect(Object.values(metadata).every((value) => typeof value === 'string')).toBe(true);
    expect(metadata['package']).toBe(manifest.name);
  });

  it('keeps SKILL.md under the spec guidance of 500 lines', () => {
    expect(skill.split('\n').length).toBeLessThan(500);
  });

  it('links only to files that exist', () => {
    for (const { file, text } of docs) {
      for (const [, target] of text.matchAll(/\]\((?!https?:)([^)#\s]+)/g)) {
        const path = resolve(dirname(join(skillDir, file)), target as string);
        expect(existsSync(path), `${file} links to ${target}`).toBe(true);
      }
    }
  });

  it('runs the CLI only as `npx --no -- agent-commerce`, never through npm scripts', () => {
    // `npx agent-commerce` can fetch an unrelated package of that name, and
    // `npx --no agent-commerce --version` prints npm's version
    for (const { file, text } of docs) {
      expect(codeOf(text), file).not.toMatch(/\bnpx\b(?! --no -- agent-commerce\b)/);
      expect(text, file).not.toMatch(/\bnpm run\b/);
    }
  });

  it('names only commands and options the CLI has', () => {
    const program = buildProgram(createCapturingIo());
    const invocations = docs.flatMap(({ file, text }) =>
      [...text.matchAll(/(?:npx --no -- |\.bin\/)agent-commerce((?:[ \t]+[^\s`'"|;&)]+)*)/g)].map(
        (match) => ({
          file,
          // A shell comment ends the command
          tokens: (match[1] ?? '')
            .replace(/\s#.*$/, '')
            .trim()
            .split(/[ \t]+/)
            .filter(Boolean),
        }),
      ),
    );
    expect(invocations.length).toBeGreaterThan(5);

    for (const { file, tokens } of invocations) {
      let command: Command = program;
      let descending = true;
      // Set after an option that takes a value, such as `--env-file`
      let takesValue = false;
      for (const token of tokens) {
        const where = `${file}: agent-commerce ${tokens.join(' ')}`;
        if (token.startsWith('-')) {
          descending = false;
          const [flag, inline] = token.split('=') as [string, string | undefined];
          const option = command.options.find((o) => o.long === flag || o.short === flag);
          const known = command.options.flatMap((o) => [o.long, o.short]);
          expect([...known, '--help', '-h'], where).toContain(flag);
          takesValue = option !== undefined && (option.required || option.optional) && !inline;
          continue;
        }
        const sub = descending ? command.commands.find((c) => c.name() === token) : undefined;
        if (sub !== undefined) {
          command = sub;
        } else {
          // An option's value, an argument the command declares, or a
          // placeholder like `<command>` in place of a command name; the CLI
          // rejects any other word
          const placeholder = token.startsWith('<') || token === '...';
          const accepted =
            takesValue ||
            command.registeredArguments.length > 0 ||
            (placeholder && command === program);
          expect(accepted, where).toBe(true);
          descending = false;
        }
        takesValue = false;
      }
    }
  });

  it('names only config keys the schema accepts', () => {
    const paths = [...schemaPaths(RawConfigSchema)].map((path) => path.split('.'));
    // A dotted path, or a single key with a value, written in backticks
    const keys = docs.flatMap(({ file, text }) =>
      [...text.matchAll(/`([a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*)(:\s[^`]*)?`/g)]
        .filter(([, key, value]) => (key as string).includes('.') || value !== undefined)
        .map(([, key]) => ({ file, key: key as string }))
        .filter(({ key }) => !/\.(ya?ml|json|md)$/.test(key)),
    );
    expect(keys.length).toBeGreaterThan(10);

    // Relative paths such as `backend.timeoutMs` match the end of a full path
    const accepted = (key: string) => {
      const want = key.split('.');
      return paths.some(
        (path) =>
          path.length >= want.length &&
          want.every((segment, i) => {
            const have = path[path.length - want.length + i];
            // `*` stands for a map key such as a resource id, so it matches
            // neither the key named nor the parent the key starts from
            return have === segment || (have === '*' && i > 0 && i < want.length - 1);
          }),
      );
    };
    for (const { file, key } of keys) expect(accepted(key), `${file}: ${key}`).toBe(true);
  });

  it('ships a config template that validates', () => {
    expect(() => parseConfig(parseYaml(asset), ENV)).not.toThrow();
  });

  it('shows only YAML that validates when applied to the template', () => {
    const blocks = docs.flatMap(({ file, text }) =>
      [...text.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => ({ file, yaml: match[1] })),
    );
    expect(blocks.length).toBeGreaterThan(0);
    for (const { file, yaml } of blocks) {
      const config = merge(parseYaml(asset), parseYaml(yaml ?? ''));
      expect(() => parseConfig(config, ENV), `${file}:\n${yaml}`).not.toThrow();
    }
  });
});

describe('Claude Code plugin', () => {
  const plugin = readJson<{ name: string; version: string; license: string }>(
    join(root, '.claude-plugin', 'plugin.json'),
  );
  const marketplace = readJson<{ name: string; plugins: { name: string; source: string }[] }>(
    join(root, '.claude-plugin', 'marketplace.json'),
  );

  it('releases with the package version', () => {
    // A set version pins installs until it changes, so it moves with each release
    expect(plugin.version).toBe(manifest.version);
    expect(plugin.license).toBe(manifest.license);
  });

  it('is listed in the marketplace from the repository root, beside the skill', () => {
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: plugin.name, source: '.' }),
    ]);
    expect(existsSync(join(root, 'skills', plugin.name, 'SKILL.md'))).toBe(true);
  });
});
