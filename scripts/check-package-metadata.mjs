#!/usr/bin/env node
/**
 * Require package and Claude Code plugin links to point at the real repository.
 * A wrong namespace could send private vulnerability reports to an attacker.
 * An allowlist rejects destinations a placeholder blocklist would miss.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const plugin = JSON.parse(readFileSync(resolve(root, '.claude-plugin', 'plugin.json'), 'utf8'));

const EXPECTED = 'github.com/devlab-group/agent-commerce';

const fields = [
  ['repository.url', manifest.repository?.url],
  ['bugs.url', manifest.bugs?.url],
  ['homepage', manifest.homepage],
  ['.claude-plugin/plugin.json repository', plugin.repository],
  ['.claude-plugin/plugin.json homepage', plugin.homepage],
];

// Anchored at the scheme and host, because npm renders these as links: a
// substring match would accept `https://evil.example/github.com/devlab-group/agent-commerce`
const ALLOWED_PREFIXES = [
  `https://${EXPECTED}`,
  `git+https://${EXPECTED}`,
  `git://${EXPECTED}`,
  `ssh://git@${EXPECTED}`,
];

function pointsAtRepository(value) {
  if (typeof value !== 'string') return false;
  return ALLOWED_PREFIXES.some(
    (prefix) => value === prefix || value.startsWith(`${prefix}.git`) || value.startsWith(`${prefix}/`) || value.startsWith(`${prefix}#`),
  );
}

const bad = fields.filter(([, value]) => !pointsAtRepository(value));

if (bad.length > 0) {
  console.error(`Provenance fields must point at ${EXPECTED}:`);
  for (const [field, value] of bad) console.error(`  ${field} = ${String(value)}`);
  process.exit(1);
}

if (manifest.private === true) {
  console.error('package.json is marked private and could not be published.');
  process.exit(1);
}

console.log(`provenance metadata ok: ${manifest.name}@${manifest.version} -> ${EXPECTED}`);
