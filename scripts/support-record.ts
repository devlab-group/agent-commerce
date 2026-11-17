/**
 * Validate the support records under `src/support/`, one per shipped profile.
 * Each record states the revision, subset, exclusions, deviations and evidence
 * its status covers. Descriptors and `doctor` trust these files at runtime.
 * This schema runs in tests and tooling and is excluded from the published
 * package.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const SUPPORT_RECORD_NAMES = ['http', 'mcp', 'a2a', 'acp', 'x402', 'mpp', 'ap2'] as const;

export const REPO_ROOT = join(import.meta.dirname, '..');

const text = z.string().min(1);

const SpecSchema = z.strictObject({
  // Revision identifiers for comparison with code
  revisions: z.array(text).min(1),
  // Display text for the pinned revision
  display: text,
  source: z.strictObject({ repo: text, commit: z.string().regex(/^[0-9a-f]{40}$/) }),
  // Whether upstream calls the pinned revision stable; null when unspecified
  stable: z.boolean().nullable(),
  // Upstream's own words on the revision's status
  statement: text,
  // The date `statement` was read
  checked: z.iso.date(),
});

const SupportRecordSchema = z
  .strictObject({
    name: z.enum(SUPPORT_RECORD_NAMES),
    kind: z.enum(['protocol', 'payment', 'authorization']),
    title: text,
    status: z.enum(['supported', 'experimental']),
    // The profile's role as a transport, payment rail or authorization method
    role: text,
    subset: text,
    spec: SpecSchema.optional(),
    // Package names; version pins live in package.json
    packages: z.array(z.strictObject({ name: text, use: z.enum(['runtime', 'test']) })),
    // Vendored schemas and fixtures
    artifacts: z.array(z.strictObject({ path: text, revision: text })),
    // Descriptor capabilities, each with its own status
    features: z.array(
      z.strictObject({
        name: text,
        status: z.enum(['supported', 'experimental', 'partial']),
        spec: SpecSchema.optional(),
      }),
    ),
    // `name` is the string the descriptor publishes in `unsupported`
    exclusions: z.array(
      z.strictObject({ name: text, note: text.optional(), feature: text.optional() }),
    ),
    deviations: z.array(
      z.strictObject({
        summary: text,
        // The specification and section the behavior departs from
        spec: text,
        upstream: text.optional(),
        tests: z.array(text).min(1),
      }),
    ),
    // Payment records: the surface, rail and authorization covered by the evidence
    combinations: z
      .array(
        z.strictObject({
          surface: z.enum(['http', 'mcp', 'a2a']),
          method: z.enum(['x402', 'mpp']),
          authorization: z.literal('ap2').optional(),
          level: z.enum(['e2e', 'integration', 'testnet', 'mainnet']),
          evidence: text,
        }),
      )
      .optional(),
    conformance: z
      .strictObject({
        suite: text,
        tests: z.array(text).min(1),
        skipped: z.array(
          z.strictObject({
            test: text,
            reason: text,
            spec: text.optional(),
            upstream: text.optional(),
          }),
        ),
      })
      .optional(),
    // Known MUST-level gaps against the pinned revision
    gaps: z.array(
      z.strictObject({ requirement: text, state: z.enum(['open', 'closed', 'excluded']) }),
    ),
    docs: z.array(text).min(1),
  })
  .superRefine((record, ctx) => {
    const duplicates = (names: readonly string[]) =>
      names.filter((name, index) => names.indexOf(name) !== index);
    const features = record.features.map((feature) => feature.name);
    for (const name of duplicates(features)) {
      ctx.addIssue({ code: 'custom', path: ['features'], message: `duplicate feature "${name}"` });
    }
    for (const name of duplicates(record.exclusions.map((exclusion) => exclusion.name))) {
      ctx.addIssue({
        code: 'custom',
        path: ['exclusions'],
        message: `duplicate exclusion "${name}"`,
      });
    }
    for (const exclusion of record.exclusions) {
      if (exclusion.feature !== undefined && !features.includes(exclusion.feature)) {
        ctx.addIssue({
          code: 'custom',
          path: ['exclusions'],
          message: `exclusion "${exclusion.name}" names unknown feature "${exclusion.feature}"`,
        });
      }
    }
    if (record.combinations !== undefined && record.kind !== 'payment') {
      ctx.addIssue({
        code: 'custom',
        path: ['combinations'],
        message: 'only a payment record lists tested combinations',
      });
    }
  });

export type SupportRecord = z.infer<typeof SupportRecordSchema>;
export type SupportRecordName = (typeof SUPPORT_RECORD_NAMES)[number];

export function supportRecordPath(name: SupportRecordName): string {
  return join(REPO_ROOT, 'src/support', `${name}.json`);
}

/** Read and validate a record; schema errors include the file path and validation details */
export function readSupportRecord(name: SupportRecordName): SupportRecord {
  const path = supportRecordPath(name);
  const parsed = SupportRecordSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new Error(`src/support/${name}.json: ${z.prettifyError(parsed.error)}`);
  }
  if (parsed.data.name !== name) {
    throw new Error(`src/support/${name}.json: name is "${parsed.data.name}", not "${name}"`);
  }
  return parsed.data;
}

/** Evidence and documentation paths to check for existence */
export function citedPaths(record: SupportRecord): string[] {
  return [
    ...record.artifacts.map((artifact) => artifact.path),
    ...(record.combinations ?? []).map((combination) => combination.evidence),
    ...(record.conformance?.tests ?? []),
    ...(record.conformance?.skipped ?? []).map((skipped) => skipped.test),
    ...record.deviations.flatMap((deviation) => deviation.tests),
    ...record.docs,
  ];
}
