/**
 * Check support records against the descriptors that publish their claims and
 * the docs generated from them. Descriptors derive status and unsupported
 * features from the records; these tests also compare capabilities and
 * revisions with their values in code.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type PackageManifest,
  REPO_ROOT,
  readSupportRecord,
  readSupportTree,
  regionUpdates,
  SUPPORT_RECORD_NAMES,
  type SupportRecord,
  type SupportRecordName,
  SupportRecordSchema,
  type SupportTree,
  supportProblems,
} from '../../scripts/support-record';
import { AP2_CAPABILITIES, AP2_UNSUPPORTED } from '../../src/ap2';
import { AP2_SPEC_VERSION } from '../../src/authorization/ap2/constants';
import { buildAp2Descriptor } from '../../src/authorization/ap2/descriptor';
import { parseConfig } from '../../src/config';
import { type AdapterDescriptor, NOOP_LOGGER } from '../../src/core';
import { createConfiguredPaymentProviders } from '../../src/gateway/payment-providers';
import { MPP_DESCRIPTOR } from '../../src/mpp';
import { MPP_SPEC_COMMIT, MPP_SPEC_DRAFTS } from '../../src/payments/mpp/constants';
import { X402_VERSION } from '../../src/payments/x402/provider/constants';
import { A2A_SPEC_VERSION, A2A_UNSUPPORTED_METHODS } from '../../src/protocols/a2a/constants';
import { buildDescriptor as buildA2aDescriptor } from '../../src/protocols/a2a/descriptor';
import { A2A_X402_EXTENSION_URI } from '../../src/protocols/a2a/x402-extension';
import { ACP_SPEC_VERSION } from '../../src/protocols/acp/constants';
import { buildDescriptor as buildAcpDescriptor } from '../../src/protocols/acp/descriptor';
import { MCP_MODERN_PROTOCOL_REVISION } from '../../src/protocols/mcp/constants';
import { buildDescriptor as buildMcpDescriptor } from '../../src/protocols/mcp/descriptor';

const records = Object.fromEntries(
  SUPPORT_RECORD_NAMES.map((name) => [name, readSupportRecord(name)]),
) as Record<SupportRecordName, SupportRecord>;

const featureNames = (record: SupportRecord) => record.features.map((feature) => feature.name);
const exclusionNames = (record: SupportRecord) => record.exclusions.map((entry) => entry.name);
const descriptorStatus = (record: SupportRecord) =>
  record.status === 'supported' ? 'stable' : 'experimental';

describe('support records', () => {
  it('holds exactly one valid record per shipped profile, each named after its file', () => {
    const files = readdirSync(join(REPO_ROOT, 'src/support'))
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.slice(0, -'.json'.length))
      .sort();
    expect(files).toEqual([...SUPPORT_RECORD_NAMES].sort());
    for (const name of SUPPORT_RECORD_NAMES) expect(records[name].name).toBe(name);
  });

  const schemaIssues = (change: (a2a: SupportRecord) => void) => {
    const a2a = structuredClone(records.a2a);
    change(a2a);
    return SupportRecordSchema.safeParse(a2a).error?.issues.map((issue) => issue.message);
  };

  it('accepts the real a2a record', () => {
    expect(schemaIssues(() => {})).toBeUndefined();
  });

  it.each([
    ['a feature without a spec', 'GetTask'],
    ['an unknown feature', 'x402-extensions'],
  ])('refuses a gap tagged with %s', (_label, featureName) => {
    expect(
      schemaIssues((a2a) => {
        a2a.gaps.push({ requirement: '§1: something', state: 'open', feature: featureName });
      }),
    ).toEqual([
      `gap "§1: something" names "${featureName}", which is not a feature with its own spec`,
    ]);
  });

  it('refuses conformance evidence on a feature without a spec', () => {
    expect(
      schemaIssues((a2a) => {
        const getTask = a2a.features.find((entry) => entry.name === 'GetTask');
        if (getTask === undefined) throw new Error('no GetTask feature');
        getTask.conformance = { suite: 'ours', tests: ['tests/x.test.ts'], skipped: [] };
      }),
    ).toEqual(['feature "GetTask" has conformance evidence but no spec to hold it against']);
  });

  // CI runs only a record's upstream suite; one on a feature would pass criterion 3 unrun
  it("refuses an upstream suite in a feature's conformance", () => {
    expect(
      schemaIssues((a2a) => {
        const extension = a2a.features.find((entry) => entry.name === 'x402-extension');
        Object.assign(extension?.conformance ?? {}, { upstream: a2a.conformance?.upstream });
      }),
    ).toEqual(['Unrecognized key: "upstream"']);
  });

  it('lists tested combinations on the payment records only', () => {
    expect(SUPPORT_RECORD_NAMES.filter((name) => records[name].combinations !== undefined)).toEqual(
      ['x402', 'mpp'],
    );
  });
});

describe('descriptors publish their record', () => {
  const cases: [SupportRecordName, AdapterDescriptor][] = [
    ['mcp', buildMcpDescriptor('test')],
    ['a2a', buildA2aDescriptor('test')],
    ['acp', buildAcpDescriptor('test')],
    ['ap2', buildAp2Descriptor('test')],
    ['mpp', MPP_DESCRIPTOR],
  ];

  it.each(cases)('%s: status, unsupported, capabilities and revision', (name, descriptor) => {
    const record = records[name];
    expect(descriptor.status).toBe(descriptorStatus(record));
    expect(descriptor.unsupported).toEqual(exclusionNames(record));
    expect(descriptor.capabilities).toEqual(featureNames(record));
    expect(descriptor.supportedSpec).toContain(record.spec?.revisions[0]);
  });

  it('a2a: the record excludes every method the transport refuses', () => {
    expect(exclusionNames(records.a2a)).toEqual(
      expect.arrayContaining([...A2A_UNSUPPORTED_METHODS]),
    );
  });
});

// LOCAL DEVELOPMENT ONLY - DO NOT FUND: Anvil accounts 1 and 3
const LOCAL_SIGNER = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const QUOTE_SIGNER = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const MERCHANT = '0x1111111111111111111111111111111111111111';
const REMOTE = { mode: 'remote', url: 'https://facilitator.example', auth: { type: 'none' } };

// These configurations collectively enable every recorded x402 capability
const X402_MATRIX: Record<string, Record<string, unknown>> = {
  'local chain, in-process facilitator': {
    network: 'eip155:31337',
    rpcUrl: 'http://127.0.0.1:8545',
    asset: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    assetName: 'MockUSDC',
    assetVersion: '2',
    assetDecimals: 6,
    payTo: MERCHANT,
    facilitator: { mode: 'local', signerPrivateKey: LOCAL_SIGNER },
  },
  'public testnets, several offers and families, quotes': {
    networks: {
      'eip155:84532': { rpcUrl: 'https://base-sepolia.example' },
      'eip155:421614': { rpcUrl: 'https://arbitrum-sepolia.example' },
      'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': { rpcUrl: 'https://solana-devnet.example' },
      'near:testnet': { rpcUrl: 'https://near-testnet.example' },
    },
    options: [
      { network: 'eip155:84532', payTo: MERCHANT },
      { network: 'eip155:421614', payTo: MERCHANT, assetTransferMethod: 'permit2' },
      {
        network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        payTo: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      },
      { network: 'near:testnet', payTo: 'merchant.testnet' },
    ],
    facilitator: REMOTE,
    quote: { enabled: true, signerPrivateKey: QUOTE_SIGNER },
    publicResourceUrl: true,
    bazaar: { enabled: true },
  },
  'Base mainnet': {
    network: 'eip155:8453',
    rpcUrl: 'https://base-mainnet.example',
    payTo: MERCHANT,
    facilitator: REMOTE,
    allowMainnet: true,
    allowUnauthenticatedFacilitator: true,
  },
};

async function x402Descriptor(x402: Record<string, unknown>): Promise<AdapterDescriptor> {
  const config = parseConfig(
    {
      version: 1,
      merchant: { id: 'shop', name: 'Shop', publicBaseUrl: 'https://shop.example' },
      server: { port: 8080, host: '127.0.0.1' },
      storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
      protocols: { http: { enabled: true }, mcp: { enabled: false, mountPath: '/mcp' } },
      resources: {
        report: {
          name: 'Report',
          backend: { type: 'http', method: 'GET', url: 'http://localhost:3000/report' },
          pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
          expose: ['http'],
          payments: ['x402'],
        },
      },
      payments: { x402: { enabled: true, maxTimeoutSeconds: 120, ...x402 } },
    },
    {},
  );
  const [provider] = await createConfiguredPaymentProviders(config.payments, NOOP_LOGGER);
  if (provider === undefined) throw new Error('no x402 provider was built');
  return provider.descriptor;
}

describe('x402 descriptor across the configuration matrix', () => {
  it('claims only recorded features, and the matrix reaches all of them', async () => {
    const record = records.x402;
    const seen = new Set<string>();
    for (const [label, x402] of Object.entries(X402_MATRIX)) {
      const descriptor = await x402Descriptor(x402);
      expect(featureNames(record), label).toEqual(
        expect.arrayContaining([...descriptor.capabilities]),
      );
      expect(descriptor.status, label).toBe(descriptorStatus(record));
      expect(descriptor.unsupported, label).toEqual(exclusionNames(record));
      expect(descriptor.supportedSpec, label).toContain(record.spec?.revisions[0]);
      for (const capability of descriptor.capabilities) seen.add(capability);
    }
    expect([...seen].sort()).toEqual(featureNames(record).sort());
  });
});

describe('revisions the records restate from code', () => {
  it('mcp: the modern revision and the SDK latest legacy one', () => {
    expect(records.mcp.spec?.revisions).toEqual([
      MCP_MODERN_PROTOCOL_REVISION,
      LATEST_PROTOCOL_VERSION,
    ]);
  });

  it('a2a, acp, ap2 and x402: the pinned revision', () => {
    expect(records.a2a.spec?.revisions).toEqual([A2A_SPEC_VERSION]);
    expect(records.acp.spec?.revisions).toEqual([ACP_SPEC_VERSION]);
    expect(records.ap2.spec?.revisions).toEqual([`v${AP2_SPEC_VERSION}`]);
    expect(records.x402.spec?.revisions).toEqual([`v${X402_VERSION}`]);
  });

  it('the a2a x402 extension: the version in its URI', () => {
    const extension = records.a2a.features.find((feature) => feature.name === 'x402-extension');
    expect(extension?.spec?.revisions).toEqual([A2A_X402_EXTENSION_URI.split('/').pop()]);
  });

  it('mpp: the three pinned drafts and their commit', () => {
    expect(records.mpp.spec?.revisions).toEqual(Object.values(MPP_SPEC_DRAFTS));
    expect(records.mpp.spec?.source.commit).toBe(MPP_SPEC_COMMIT);
  });
});

describe('published exports derived from a record keep their 2.7 types', () => {
  it('AP2_UNSUPPORTED, AP2_CAPABILITIES and MPP_DESCRIPTOR', () => {
    // Checked by tsc: a JSON import would otherwise widen or narrow these
    expectTypeOf(AP2_UNSUPPORTED).toEqualTypeOf<readonly string[]>();
    expectTypeOf(AP2_CAPABILITIES).toEqualTypeOf<readonly string[]>();
    expectTypeOf(MPP_DESCRIPTOR).toEqualTypeOf<AdapterDescriptor>();
  });
});

describe('drift between the records, package.json and the docs', () => {
  const tree = readSupportTree();

  // A writable copy of package.json's dependency sections
  type Manifest = { -readonly [K in keyof PackageManifest]-?: Record<string, string> };

  interface Change {
    readonly records?: (records: SupportRecord[]) => void;
    readonly manifest?: (manifest: Manifest) => void;
    readonly edit?: Readonly<Record<string, (content: string) => string>>;
    readonly deleted?: string;
  }

  // The real tree with one change, made on copies
  function changed(change: Change): SupportTree {
    const mutated = structuredClone(tree.records) as SupportRecord[];
    const manifest = structuredClone(tree.manifest) as Manifest;
    change.records?.(mutated);
    change.manifest?.(manifest);
    return {
      records: mutated,
      manifest,
      read: (path) => {
        const content = tree.read(path);
        const edit = change.edit?.[path];
        return content === undefined || edit === undefined ? content : edit(content);
      },
      exists: (path) => path !== change.deleted && tree.exists(path),
    };
  }

  const record = (records: SupportRecord[], name: SupportRecordName) => {
    const found = records.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`no ${name} record`);
    return found;
  };
  const feature = (records: SupportRecord[], name: SupportRecordName, featureName: string) => {
    const found = record(records, name).features.find((entry) => entry.name === featureName);
    if (found === undefined) throw new Error(`no ${featureName} feature in ${name}`);
    return found;
  };

  // A feature promoted in its record alone, still experimental in hand-written prose
  const stillCalledExperimental = (title: string, name: SupportRecordName) =>
    [
      'README.md: the Versioning sentence',
      'README.md: the "experimental entries above" sentence',
      'plugins/agent-commerce-gateway/skills/agent-commerce/SKILL.md: the "exist but are experimental" sentence',
    ].map(
      (place) => `${place} names ${title}, which src/support/${name}.json records as supported`,
    );
  const stale = (path: string, region: string, source: string) =>
    `${path}: region "${region}" differs from ${source}; run npm run support:write`;
  const ALL = 'src/support/*.json and package.json';

  it('finds none on the real tree, and --write would change no file', () => {
    expect(supportProblems(tree)).toEqual([]);
    expect([...regionUpdates(tree).keys()]).toEqual([]);
  });

  const HAND_EDIT: Change = {
    edit: {
      'README.md': (content) =>
        content.replace(/(\| \*\*MPP\*\* +\| )Experimental/, '$1Supported   '),
    },
  };
  const MARKERS_REMOVED: Change = {
    edit: {
      'docs/protocols/mcp.md': (content) =>
        content.replace(
          /<!-- support-record:begin pins -->[\s\S]*?<!-- support-record:end -->/,
          '',
        ),
    },
  };

  const cases: [string, Change, string[]][] = [
    [
      'a package version bumped in package.json',
      {
        manifest: (manifest) => {
          manifest.peerDependencies.mppx = '0.13.2';
        },
      },
      [
        stale('README.md', 'matrix', ALL),
        stale('docs/protocols.md', 'matrix', ALL),
        stale('docs/protocols/mpp.md', 'pins', 'src/support/mpp.json and package.json'),
      ],
    ],
    [
      'a recorded package missing from package.json',
      {
        manifest: (manifest) => {
          delete manifest.peerDependencies['@sd-jwt/core'];
          delete manifest.devDependencies['@sd-jwt/core'];
        },
      },
      [
        'src/support/ap2.json: package @sd-jwt/core (runtime) is not in package.json dependencies or peerDependencies',
        stale('README.md', 'matrix', ALL),
        stale('docs/protocols.md', 'matrix', ALL),
        stale('docs/protocols/ap2.md', 'pins', 'src/support/ap2.json and package.json'),
      ],
    ],
    [
      'an exclusion added to a record',
      { records: (records) => void record(records, 'acp').exclusions.push({ name: 'carts' }) },
      [stale('docs/protocols/acp.md', 'exclusions', 'src/support/acp.json')],
    ],
    [
      'an experimental profile recorded as supported',
      {
        records: (records) => {
          record(records, 'acp').status = 'supported';
        },
      },
      [
        // ACP's upstream snapshot is not declared stable
        'src/support/acp.json: supported, but criterion 1: upstream does not declare the pinned revision stable (spec.stable)',
        stale('README.md', 'badges', 'src/support/*.json'),
        stale('README.md', 'matrix', ALL),
        stale('docs/protocols.md', 'matrix', ALL),
        'README.md: the Versioning sentence names ACP, which src/support/acp.json records as supported',
        'README.md: the "experimental entries above" sentence names ACP, which src/support/acp.json records as supported',
        'plugins/agent-commerce-gateway/skills/agent-commerce/SKILL.md: the "exist but are experimental" sentence names ACP, which src/support/acp.json records as supported',
        'docs/protocols/acp.md: says **Experimental.**, but src/support/acp.json records supported',
      ],
    ],
    [
      'a supported profile whose upstream revision is not stable',
      {
        records: (records) => {
          const a2a = record(records, 'a2a');
          if (a2a.spec !== undefined) a2a.spec.stable = false;
        },
      },
      [
        'src/support/a2a.json: supported, but criterion 1: upstream does not declare the pinned revision stable (spec.stable)',
        stale('docs/protocols/a2a.md', 'pins', 'src/support/a2a.json and package.json'),
      ],
    ],
    [
      'a supported profile with no pinned revision',
      {
        records: (records) => {
          delete record(records, 'a2a').spec;
        },
      },
      [
        'src/support/a2a.json: supported, but criterion 1: upstream does not declare the pinned revision stable (spec.stable)',
        // Badges show only the profiles that pin a specification
        stale('README.md', 'badges', 'src/support/*.json'),
        stale('README.md', 'matrix', ALL),
        stale('docs/protocols.md', 'matrix', ALL),
        stale('docs/protocols/a2a.md', 'pins', 'src/support/a2a.json and package.json'),
      ],
    ],
    [
      'a supported profile whose only remaining gap is excluded',
      {
        records: (records) => {
          record(records, 'a2a').gaps.push({ requirement: '§9.9: something', state: 'excluded' });
        },
      },
      [],
    ],
    [
      'a supported profile with an open gap',
      {
        records: (records) => {
          record(records, 'a2a').gaps.push({ requirement: '§9.9: something', state: 'open' });
        },
      },
      ['src/support/a2a.json: supported, but criterion 2: the gap "§9.9: something" is open'],
    ],
    [
      'a supported profile without conformance evidence',
      {
        records: (records) => {
          delete record(records, 'a2a').conformance;
        },
      },
      ['src/support/a2a.json: supported, but criterion 3: no conformance evidence'],
    ],
    [
      'a supported profile without docs',
      {
        records: (records) => {
          record(records, 'a2a').docs = [];
        },
      },
      ['src/support/a2a.json: supported, but criterion 4: no operational docs'],
    ],
    [
      'a supported feature whose upstream revision is not stable',
      {
        records: (records) => {
          feature(records, 'a2a', 'x402-extension').status = 'supported';
        },
      },
      [
        'src/support/a2a.json: feature "x402-extension" supported, but criterion 1: upstream does not declare the pinned revision stable (spec.stable)',
        stale('README.md', 'matrix', ALL),
        stale('docs/protocols.md', 'matrix', ALL),
        ...stillCalledExperimental('A2A x402 extension', 'a2a'),
      ],
    ],
    [
      'a supported feature with an open gap of its own and no evidence',
      {
        records: (records) => {
          const extension = feature(records, 'a2a', 'x402-extension');
          extension.status = 'supported';
          if (extension.spec !== undefined) extension.spec.stable = true;
          delete extension.conformance;
          record(records, 'a2a').gaps.push({
            requirement: '§9.9: something',
            state: 'open',
            feature: 'x402-extension',
          });
        },
      },
      [
        'src/support/a2a.json: feature "x402-extension" supported, but criterion 2: the gap "§9.9: something" is open',
        'src/support/a2a.json: feature "x402-extension" supported, but criterion 3: no conformance evidence',
        stale('README.md', 'matrix', ALL),
        stale('docs/protocols.md', 'matrix', ALL),
        stale('docs/protocols/a2a.md', 'pins', 'src/support/a2a.json and package.json'),
        ...stillCalledExperimental('A2A x402 extension', 'a2a'),
      ],
    ],
    [
      'a supported profile with an open gap tagged with an experimental feature',
      {
        records: (records) => {
          record(records, 'a2a').gaps.push({
            requirement: '§9.9: something',
            state: 'open',
            feature: 'x402-extension',
          });
        },
      },
      [],
    ],
    [
      'a supported feature with its own spec in a profile supported before the criteria',
      {
        records: (records) => {
          feature(records, 'x402', 'erc-8409-quotes').status = 'supported';
        },
      },
      [
        'src/support/x402.json: feature "erc-8409-quotes" supported, but criterion 1: upstream does not declare the pinned revision stable (spec.stable)',
        'src/support/x402.json: feature "erc-8409-quotes" supported, but criterion 3: no conformance evidence',
        stale('README.md', 'matrix', ALL),
        stale('docs/protocols.md', 'matrix', ALL),
        ...stillCalledExperimental('ERC-8409', 'x402'),
      ],
    ],
    [
      'a supported feature with its own spec inside an experimental record',
      {
        records: (records) => {
          const copy = structuredClone(feature(records, 'a2a', 'x402-extension'));
          delete copy.alias;
          if (copy.spec !== undefined) copy.spec.stable = true;
          record(records, 'mpp').features.push({
            ...copy,
            name: 'mpp-extension',
            title: 'MPP extension',
            status: 'supported',
          });
        },
      },
      [
        'src/support/mpp.json: feature "mpp-extension" supported inside an experimental record',
        stale('README.md', 'matrix', ALL),
        stale('docs/protocols.md', 'matrix', ALL),
        stale('docs/protocols/mpp.md', 'pins', 'src/support/mpp.json and package.json'),
      ],
    ],
    [
      'a feature with its own spec inside a record that pins nothing',
      {
        records: (records) => {
          const copy = structuredClone(feature(records, 'a2a', 'x402-extension'));
          delete copy.alias;
          record(records, 'http').features.push({
            ...copy,
            name: 'http-extension',
            title: 'HTTP extension',
            status: 'partial',
          });
        },
      },
      [
        stale('README.md', 'matrix', ALL),
        stale('docs/protocols.md', 'matrix', ALL),
        'docs/protocols/http.md: region "pins" appears 0 times, not once',
      ],
    ],
    [
      'an experimental feature missing from the "experimental entries above" sentence under its alias',
      {
        edit: {
          'README.md': (content) =>
            content.replace('[a2a-x402 extension](docs', '[payment extension](docs'),
        },
      },
      [
        'README.md: the "experimental entries above" sentence omits A2A x402 extension, which src/support/a2a.json records as experimental',
      ],
    ],
    [
      'an experimental feature missing from the Versioning sentence',
      {
        edit: {
          'README.md': (content) => content.replace('ERC-8409 quotes, the', 'the'),
        },
      },
      [
        'README.md: the Versioning sentence omits ERC-8409, which src/support/x402.json records as experimental',
      ],
    ],
    [
      "a deleted test cited as a feature's conformance evidence",
      { deleted: 'tests/unit/protocols-a2a/payment-resume.test.ts' },
      [
        'src/support/a2a.json: cites tests/unit/protocols-a2a/payment-resume.test.ts, which does not exist',
      ],
    ],
    [
      'an open gap on a profile supported before the criteria',
      {
        records: (records) => {
          record(records, 'mcp').gaps.push({ requirement: '§9.9: something', state: 'open' });
        },
      },
      [],
    ],
    ['a hand edit inside a generated region', HAND_EDIT, [stale('README.md', 'matrix', ALL)]],
    [
      'a deleted evidence file',
      { deleted: 'tests/e2e/payment/x402-settlement.e2e.test.ts' },
      [
        'src/support/x402.json: cites tests/e2e/payment/x402-settlement.e2e.test.ts, which does not exist',
      ],
    ],
    [
      'an experimental profile missing from the Versioning sentence',
      {
        edit: {
          'README.md': (content) => content.replace('MPP, ACP, AP2,', 'ACP, AP2,'),
        },
      },
      [
        'README.md: the Versioning sentence omits MPP, which src/support/mpp.json records as experimental',
      ],
    ],
    [
      'an x402 route row whose status differs from its feature',
      {
        edit: {
          'docs/protocols/x402.md': (content) =>
            content.replace(/(\| NEAR +\| )partial/, '$1supported'),
        },
      },
      [
        'docs/protocols/x402.md: the "NEAR" row says supported, but src/support/x402.json records exact-near as partial',
      ],
    ],
    [
      'a region whose markers were removed',
      MARKERS_REMOVED,
      ['docs/protocols/mcp.md: region "pins" appears 0 times, not once'],
    ],
  ];

  it.each(cases)('names the place of %s', (_, change, expected) => {
    expect(supportProblems(changed(change))).toEqual(expected);
  });

  it('escapes a pipe inside a generated table cell', () => {
    const piped = changed({
      records: (records) => {
        record(records, 'acp').subset = 'checkout | discovery';
      },
    });
    expect(regionUpdates(piped).get('docs/protocols.md')).toContain('checkout \\| discovery');
  });

  it('--write restores a hand-edited region and refuses a file with missing markers', () => {
    expect(regionUpdates(changed(HAND_EDIT))).toEqual(
      new Map([['README.md', tree.read('README.md')]]),
    );
    expect(() => regionUpdates(changed(MARKERS_REMOVED))).toThrow(
      'docs/protocols/mcp.md: add the markers for region(s) pins first',
    );
  });
});
