/**
 * Validate the support records under `src/support/`, one per shipped profile,
 * and render the docs regions generated from them. Each record states the
 * revision, subset, exclusions, deviations and evidence its status covers.
 * Descriptors and `doctor` trust these files at runtime. This schema runs in
 * tests and tooling and is excluded from the published package.
 *
 *   npm run support:write   rewrite every generated region from the records
 *
 * `tests/integration/support-record.test.ts` fails on any drift and names the
 * file, the region and the record.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Also the order every generated table lists the profiles in
export const SUPPORT_RECORD_NAMES = ['http', 'mcp', 'x402', 'mpp', 'a2a', 'acp', 'ap2'] as const;

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
        // A feature with its own spec gets its own matrix row, under `title`
        spec: SpecSchema.optional(),
        title: text.optional(),
        role: text.optional(),
        subset: text.optional(),
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
    for (const feature of record.features) {
      const row = [feature.title, feature.role, feature.subset];
      if ((feature.spec !== undefined) !== row.every((field) => field !== undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: ['features'],
          message: `feature "${feature.name}" needs title, role and subset exactly when it has a spec`,
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

/** Evidence and documentation paths to check for existence, each once */
export function citedPaths(record: SupportRecord): string[] {
  return [
    ...new Set([
      ...record.artifacts.map((artifact) => artifact.path),
      ...(record.combinations ?? []).map((combination) => combination.evidence),
      ...(record.conformance?.tests ?? []),
      ...(record.conformance?.skipped ?? []).map((skipped) => skipped.test),
      ...record.deviations.flatMap((deviation) => deviation.tests),
      ...record.docs,
    ]),
  ];
}

export interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

/** Everything the drift check reads, injectable for tests that mutate a copy */
export interface SupportTree {
  readonly records: readonly SupportRecord[];
  readonly manifest: PackageManifest;
  /** Undefined when the file does not exist */
  readonly read: (path: string) => string | undefined;
  readonly exists: (path: string) => boolean;
}

export function readSupportTree(): SupportTree {
  return {
    records: SUPPORT_RECORD_NAMES.map(readSupportRecord),
    manifest: JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as PackageManifest,
    read: (path) => {
      const full = join(REPO_ROOT, path);
      return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
    },
    exists: (path) => existsSync(join(REPO_ROOT, path)),
  };
}

// Rendering

const STATUS_WORD = { supported: 'Supported', experimental: 'Experimental', partial: 'Partial' };

// Supported badges keep each project's color; experimental ones share one
const BADGE_COLOR: Readonly<Record<string, string>> = { mcp: '6b4fbb', x402: '0052ff' };
const SUPPORTED_BADGE = '2ea44f';
const EXPERIMENTAL_BADGE = 'f0a30a';

const SURFACE_TITLE = { http: 'HTTP', mcp: 'MCP', a2a: 'A2A' };
const LEVEL_TITLE = {
  e2e: 'E2E, local chain',
  integration: 'integration, no chain',
  testnet: 'public testnet',
  mainnet: 'mainnet',
};

// A Markdown table with every column padded to its widest cell
function table(header: readonly string[], body: readonly (readonly string[])[]): string {
  const rows = body.map((row) => row.map((cell) => cell.replaceAll('|', '\\|')));
  const widths = header.map((cell, column) =>
    Math.max(3, cell.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: readonly string[]) =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(' | ')} |`;
  return [line(header), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join(
    '\n',
  );
}

// A Markdown block between region markers, set off by blank lines
const block = (text: string) => `\n${text}\n\n`;

type Spec = NonNullable<SupportRecord['spec']>;
type Package = SupportRecord['packages'][number];

function packageVersion(manifest: PackageManifest, pkg: Package): string | undefined {
  return pkg.use === 'test'
    ? manifest.devDependencies?.[pkg.name]
    : (manifest.peerDependencies?.[pkg.name] ?? manifest.dependencies?.[pkg.name]);
}

const pinned = (manifest: PackageManifest, pkg: Package) =>
  `\`${pkg.name}@${packageVersion(manifest, pkg) ?? 'missing'}\``;

function revisionCell(record: SupportRecord, manifest: PackageManifest): string {
  const runtime = record.packages.filter((pkg) => pkg.use === 'runtime');
  const packages = runtime.map((pkg) => pinned(manifest, pkg)).join(', ');
  const display = record.spec?.display ?? 'native';
  return packages === '' ? display : `${display}; ${packages}`;
}

interface MatrixRow {
  readonly title: string;
  readonly status: string;
  readonly role: string;
  readonly revision: string;
  readonly subset: string;
}

// One row per record, then one per feature that has its own spec
function matrixRows(records: readonly SupportRecord[], manifest: PackageManifest): MatrixRow[] {
  return [
    ...records.map((record) => ({
      title: record.title,
      status: STATUS_WORD[record.status],
      role: record.role,
      revision: revisionCell(record, manifest),
      subset: record.subset,
    })),
    ...records.flatMap((record) =>
      record.features.flatMap((feature) =>
        feature.spec === undefined
          ? []
          : [
              {
                title: feature.title ?? feature.name,
                status: STATUS_WORD[feature.status],
                role: feature.role ?? '',
                revision: feature.spec.display,
                subset: feature.subset ?? '',
              },
            ],
      ),
    ),
  ];
}

function badges(records: readonly SupportRecord[]): string {
  return records
    .filter((record) => record.spec !== undefined)
    .map((record) => {
      const color =
        record.status === 'experimental'
          ? EXPERIMENTAL_BADGE
          : (BADGE_COLOR[record.name] ?? SUPPORTED_BADGE);
      const label = record.title.replaceAll('-', '--');
      return `  <img alt="${record.title}" src="https://img.shields.io/badge/${label}-${record.status}-${color}">\n`;
    })
    .join('');
}

function specRows(spec: Spec, prefix: string): string[][] {
  const commit = spec.source.commit;
  const stable = spec.stable === null ? 'not stated' : spec.stable ? 'yes' : 'no';
  return [
    [`${prefix}pinned revision`, spec.display],
    [
      `${prefix}upstream source`,
      `[\`${spec.source.repo}@${commit.slice(0, 8)}\`](https://github.com/${spec.source.repo}/tree/${commit})`,
    ],
    [`${prefix}declared stable upstream`, stable],
    [`${prefix}upstream wording`, `"${spec.statement}" (read ${spec.checked})`],
  ];
}

function pins(record: SupportRecord, manifest: PackageManifest): string {
  const use = (pkg: Package) => {
    if (pkg.use === 'test') return 'tests only';
    return manifest.peerDependencies?.[pkg.name] !== undefined ? 'optional peer' : 'dependency';
  };
  const rows = [
    ...(record.spec === undefined ? [] : specRows(record.spec, '')),
    ...record.features.flatMap((feature) =>
      feature.spec === undefined ? [] : specRows(feature.spec, `${feature.title} `),
    ),
    ...record.packages.map((pkg) => [
      `\`${pkg.name}\``,
      `\`${packageVersion(manifest, pkg) ?? 'missing'}\`, ${use(pkg)}`,
    ]),
    ...record.artifacts.map((artifact) => [
      `\`${artifact.path}\``,
      `vendored from \`${artifact.revision.slice(0, 8)}\``,
    ]),
  ];
  // Capitalize the first word of each label that is not a package or a path
  const label = (cell: string) =>
    cell.startsWith('`') ? cell : `${cell.charAt(0).toUpperCase()}${cell.slice(1)}`;
  return table(
    ['Pin', 'Value'],
    rows.map(([name = '', value = '']) => [label(name), value]),
  );
}

function exclusionList(exclusions: SupportRecord['exclusions']): string {
  return exclusions
    .map(
      (exclusion) =>
        `- \`${exclusion.name}\`${exclusion.note === undefined ? '' : `: ${exclusion.note}`}`,
    )
    .join('\n');
}

function deviationList(record: SupportRecord): string {
  return record.deviations
    .map((deviation) => {
      const tests = deviation.tests.map((test) => `\`${test}\``).join(', ');
      const upstream =
        deviation.upstream === undefined ? '' : ` Reported upstream: ${deviation.upstream}.`;
      return `- **${deviation.spec}**: ${deviation.summary}${upstream} Tests: ${tests}.`;
    })
    .join('\n');
}

function combinations(records: readonly SupportRecord[]): string {
  const rows = records.flatMap((record) =>
    (record.combinations ?? []).map((combination) => [
      record.title,
      SURFACE_TITLE[combination.surface],
      combination.authorization === undefined ? '-' : 'AP2',
      LEVEL_TITLE[combination.level],
      `\`${combination.evidence}\``,
    ]),
  );
  return table(['Rail', 'Surface', 'Authorization', 'Tested at', 'Test'], rows);
}

export interface RenderedRegion {
  readonly body: string;
  /** What the region is generated from, named in a drift report */
  readonly source: string;
}

/** Every generated region, by repository path and region id */
export function renderRegions(
  records: readonly SupportRecord[],
  manifest: PackageManifest,
): Map<string, Map<string, RenderedRegion>> {
  const all = 'src/support/*.json and package.json';
  const matrix = matrixRows(records, manifest);
  const regions = new Map<string, Map<string, RenderedRegion>>([
    [
      'README.md',
      new Map([
        ['badges', { body: badges(records), source: 'src/support/*.json' }],
        [
          'matrix',
          {
            body: block(
              table(
                ['Protocol', 'Status', 'Pinned revision', 'Implemented subset'],
                matrix.map((row) => [`**${row.title}**`, row.status, row.revision, row.subset]),
              ),
            ),
            source: all,
          },
        ],
      ]),
    ],
    [
      'docs/protocols.md',
      new Map([
        [
          'matrix',
          {
            body: block(
              table(
                ['Protocol', 'Status', 'Role', 'Revision', 'Implemented subset'],
                matrix.map((row) => [
                  `**${row.title}**`,
                  row.status,
                  row.role,
                  row.revision,
                  row.subset,
                ]),
              ),
            ),
            source: all,
          },
        ],
        ['combinations', { body: block(combinations(records)), source: 'src/support/*.json' }],
      ]),
    ],
  ]);
  for (const record of records) {
    const source = `src/support/${record.name}.json`;
    const page = new Map<string, RenderedRegion>();
    if (record.spec !== undefined || record.packages.length > 0 || record.artifacts.length > 0) {
      page.set('pins', {
        body: block(pins(record, manifest)),
        source: `${source} and package.json`,
      });
    }
    const untagged = record.exclusions.filter((exclusion) => exclusion.feature === undefined);
    if (untagged.length > 0) {
      page.set('exclusions', { body: block(exclusionList(untagged)), source });
    }
    for (const feature of new Set(record.exclusions.flatMap((e) => e.feature ?? []))) {
      const tagged = record.exclusions.filter((exclusion) => exclusion.feature === feature);
      page.set(`exclusions:${feature}`, { body: block(exclusionList(tagged)), source });
    }
    if (record.deviations.length > 0) {
      page.set('deviations', { body: block(deviationList(record)), source });
    }
    if (page.size > 0) regions.set(`docs/protocols/${record.name}.md`, page);
  }
  return regions;
}

// Regions in a file

const REGION =
  /^([ \t]*)<!-- support-record:begin (\S+) -->\n([\s\S]*?)^[ \t]*<!-- support-record:end -->/gm;

interface FoundRegion {
  readonly id: string;
  readonly body: string;
}

function findRegions(content: string): FoundRegion[] {
  return [...content.matchAll(REGION)].map((match) => ({
    id: match[2] ?? '',
    body: match[3] ?? '',
  }));
}

function replaceRegions(content: string, rendered: ReadonlyMap<string, RenderedRegion>): string {
  return content.replace(REGION, (whole, indent: string, id: string) => {
    const region = rendered.get(id);
    if (region === undefined) return whole;
    return `${indent}<!-- support-record:begin ${id} -->\n${region.body}${indent}<!-- support-record:end -->`;
  });
}

// The drift check

const titleNamed = (text: string, title: string) =>
  new RegExp(`(^|[^\\w-])${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text);

// Hand-written sentences that name the experimental profiles
const STATUS_SENTENCES = [
  {
    path: 'README.md',
    place: 'Versioning sentence',
    find: (content: string) => /### Versioning\n\n([\s\S]*?)\n\n/.exec(content)?.[1],
  },
  {
    path: 'plugins/agent-commerce-gateway/skills/agent-commerce/SKILL.md',
    place: '"exist but are experimental" sentence',
    find: (content: string) => /[^.]*exist but are experimental[^.]*\./.exec(content)?.[0],
  },
];

// x402 route table rows, by the start of the route, and the feature each row states
const X402_ROUTES: readonly [string, string][] = [
  ['EIP-3009 ', 'eip-3009'],
  ['Permit2 ', 'permit2'],
  ['Solana', 'exact-svm'],
  ['NEAR', 'exact-near'],
];

function handWrittenProblems(tree: SupportTree): string[] {
  const problems: string[] = [];
  const experimental = tree.records.filter((record) => record.status === 'experimental');
  for (const sentence of STATUS_SENTENCES) {
    const text = sentence.find(tree.read(sentence.path) ?? '');
    if (text === undefined) {
      problems.push(`${sentence.path}: ${sentence.place} not found`);
      continue;
    }
    for (const record of tree.records) {
      const named = titleNamed(text, record.title);
      if (named !== experimental.includes(record)) {
        problems.push(
          `${sentence.path}: the ${sentence.place} ${named ? 'names' : 'omits'} ${record.title}, which src/support/${record.name}.json records as ${record.status}`,
        );
      }
    }
  }
  for (const record of tree.records) {
    const path = `docs/protocols/${record.name}.md`;
    const marked = (tree.read(path) ?? '').includes('**Experimental.**');
    if (marked !== (record.status === 'experimental')) {
      problems.push(
        `${path}: ${marked ? 'says' : 'does not say'} **Experimental.**, but src/support/${record.name}.json records ${record.status}`,
      );
    }
  }
  const x402 = tree.records.find((record) => record.name === 'x402');
  const routes = /## Support matrix\n[\s\S]*?\n(\|[\s\S]*?)\n\n/.exec(
    tree.read('docs/protocols/x402.md') ?? '',
  )?.[1];
  for (const [prefix, featureName] of X402_ROUTES) {
    const feature = x402?.features.find((candidate) => candidate.name === featureName);
    const rows = (routes ?? '')
      .split('\n')
      .map((line) => line.split('|').map((cell) => cell.trim()))
      .filter((cells) => cells[1]?.startsWith(prefix));
    if (rows.length === 0) {
      problems.push(`docs/protocols/x402.md: no support matrix row starts with "${prefix.trim()}"`);
    }
    for (const cells of rows) {
      if (cells[2] !== feature?.status) {
        problems.push(
          `docs/protocols/x402.md: the "${cells[1]}" row says ${cells[2]}, but src/support/x402.json records ${featureName} as ${feature?.status}`,
        );
      }
    }
  }
  return problems;
}

/** Every disagreement between the records, package.json and the docs, each naming its place */
export function supportProblems(tree: SupportTree): string[] {
  const problems: string[] = [];
  const { manifest } = tree;
  for (const record of tree.records) {
    const source = `src/support/${record.name}.json`;
    for (const pkg of record.packages) {
      const runtime = manifest.peerDependencies?.[pkg.name] ?? manifest.dependencies?.[pkg.name];
      const declared =
        pkg.use === 'runtime'
          ? runtime !== undefined
          : manifest.devDependencies?.[pkg.name] !== undefined && runtime === undefined;
      if (!declared) {
        problems.push(
          `${source}: package ${pkg.name} (${pkg.use}) is not in package.json ${pkg.use === 'runtime' ? 'dependencies or peerDependencies' : 'devDependencies alone'}`,
        );
      }
    }
    for (const path of citedPaths(record)) {
      if (!tree.exists(path)) problems.push(`${source}: cites ${path}, which does not exist`);
    }
  }
  for (const [path, regions] of renderRegions(tree.records, manifest)) {
    const content = tree.read(path);
    if (content === undefined) {
      problems.push(`${path}: missing, but support regions are generated into it`);
      continue;
    }
    const found = findRegions(content);
    for (const [id, region] of regions) {
      const matches = found.filter((candidate) => candidate.id === id);
      if (matches.length !== 1) {
        problems.push(`${path}: region "${id}" appears ${matches.length} times, not once`);
      } else if (matches[0]?.body !== region.body) {
        problems.push(
          `${path}: region "${id}" differs from ${region.source}; run npm run support:write`,
        );
      }
    }
    for (const region of found) {
      if (!regions.has(region.id)) problems.push(`${path}: unknown region "${region.id}"`);
    }
  }
  return [...problems, ...handWrittenProblems(tree)];
}

/** The new content of each file whose generated regions are out of date */
export function regionUpdates(tree: SupportTree): Map<string, string> {
  const updates = new Map<string, string>();
  for (const [path, regions] of renderRegions(tree.records, tree.manifest)) {
    const content = tree.read(path);
    if (content === undefined) throw new Error(`${path}: missing`);
    const ids = new Set(findRegions(content).map((region) => region.id));
    const absent = [...regions.keys()].filter((id) => !ids.has(id));
    if (absent.length > 0) {
      throw new Error(`${path}: add the markers for region(s) ${absent.join(', ')} first`);
    }
    const next = replaceRegions(content, regions);
    if (next !== content) updates.set(path, next);
  }
  return updates;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--write')) {
    console.error('usage: tsx scripts/support-record.ts --write');
    process.exit(2);
  }
  const updates = regionUpdates(readSupportTree());
  for (const [path, content] of updates) writeFileSync(join(REPO_ROOT, path), content);
  console.log(
    updates.size === 0
      ? 'support regions: unchanged'
      : `support regions: rewrote ${[...updates.keys()].join(', ')}`,
  );
}
