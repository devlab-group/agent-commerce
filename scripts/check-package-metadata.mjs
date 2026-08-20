#!/usr/bin/env node
/**
 * Assert the published package's provenance fields point at the real
 * repository.
 *
 * Stated positively rather than as a placeholder blocklist: a blocklist only
 * catches the placeholder spelling someone happened to think of. This is what
 * stops npm's repository link and "report a vulnerability" path resolving to a
 * namespace an attacker can register — which for a payments project whose
 * SECURITY.md asks for private disclosure is a cheap interception route.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const EXPECTED = 'github.com/devlab-group/agent-commerce';

const fields = [
  ['repository.url', manifest.repository?.url],
  ['bugs.url', manifest.bugs?.url],
  ['homepage', manifest.homepage],
];

// `.includes()` accepts the expected string *anywhere*,
// so `https://evil.example/github.com/devlab-group/agent-commerce` passed.
// Anchor it to the host instead — npm renders these as links.
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
  console.error(`package.json provenance fields must point at ${EXPECTED}:`);
  for (const [field, value] of bad) console.error(`  ${field} = ${String(value)}`);
  process.exit(1);
}

if (manifest.private === true) {
  console.error('package.json is marked private and could not be published.');
  process.exit(1);
}

console.log(`provenance metadata ok — ${manifest.name}@${manifest.version} -> ${EXPECTED}`);
