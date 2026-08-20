import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import * as clack from '@clack/prompts';
import { DEFAULT_CONFIG_FILENAME } from '../../config/filename.js';
import {
  type ConfigLoader,
  type ConfigParser,
  type GatewayConfig,
  loadConfigDynamic,
  parseConfigDynamic,
} from '../lib/config-client.js';
import {
  buildInitConfigObject,
  defaultInitAnswers,
  type InitAnswers,
  type InitProtocolChoice,
  type InitResourceChoice,
  renderInitConfigYaml,
} from '../lib/init-config.js';
import type { Io } from '../lib/io.js';
import { formatConfigError } from './validate.js';

export interface InitOptions {
  readonly outputPath?: string;
  readonly force?: boolean;
  readonly yes?: boolean;
}

export interface InitDeps {
  readonly loadConfig?: ConfigLoader;
  readonly parseConfig?: ConfigParser;
  readonly collectAnswers?: () => Promise<InitAnswers | undefined>;
  readonly fileExists?: (path: string) => boolean;
  readonly writeFile?: (path: string, content: string) => Promise<void>;
}

/** Exported for testing: the real interactive prompt flow (mocks `@clack/prompts`). */
export async function collectAnswersInteractive(): Promise<InitAnswers | undefined> {
  clack.intro('agent-commerce init');

  const backendBaseUrl = await clack.text({
    message: 'Backend base URL (your existing merchant API)',
    initialValue: 'http://localhost:3000',
    // shape-checked here, where the user can retype it,
    // rather than surfacing as a config error after the fact.
    validate: (value) => {
      const trimmed = (value ?? '').trim();
      if (trimmed.length === 0) return 'Required';
      let parsed: URL;
      try {
        parsed = new URL(trimmed);
      } catch {
        return 'Must be an absolute URL, e.g. http://localhost:3000';
      }
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
        ? undefined
        : 'Must use http:// or https://';
    },
  });
  if (clack.isCancel(backendBaseUrl)) {
    clack.cancel('Aborted.');
    return undefined;
  }

  const resources = await clack.multiselect<InitResourceChoice>({
    message: 'Which example resource(s) do you want to expose?',
    options: [
      { value: 'weather', label: 'Weather (free)' },
      { value: 'report', label: 'Market report (paid)' },
    ],
    initialValues: ['weather', 'report'],
    required: false,
  });
  if (clack.isCancel(resources)) {
    clack.cancel('Aborted.');
    return undefined;
  }

  const protocols = await clack.multiselect<InitProtocolChoice>({
    message: 'Which protocols should be enabled?',
    options: [
      { value: 'http', label: 'HTTP' },
      { value: 'mcp', label: 'MCP' },
    ],
    initialValues: ['http', 'mcp'],
    // `required: false` permits an empty selection, which renders
    // `expose: []` on every resource and fails the schema's min(1). clack's
    // multiselect has no `validate` hook, so this is caught by the in-memory
    // validation in `runInit` — which now reports the real schema error and
    // writes nothing, instead of leaving an invalid file behind.
    required: false,
  });
  if (clack.isCancel(protocols)) {
    clack.cancel('Aborted.');
    return undefined;
  }

  const x402Enabled = await clack.confirm({ message: 'Enable x402 payments?', initialValue: true });
  if (clack.isCancel(x402Enabled)) {
    clack.cancel('Aborted.');
    return undefined;
  }

  let merchantPayTo = defaultInitAnswers().merchantPayTo;
  if (x402Enabled) {
    const answer = await clack.text({
      message:
        'Merchant settlement destination address (merchant-controlled — never a gateway-owned wallet)',
      initialValue: merchantPayTo,
      validate: (value) => {
        const trimmed = (value ?? '').trim();
        if (trimmed.length === 0) return 'Required';
        // Same shape the config schema enforces; catching it here means a
        // typo'd address never reaches the "generated config is invalid" path.
        return /^0x[0-9a-fA-F]{40}$/.test(trimmed)
          ? undefined
          : 'Must be a 0x-prefixed 20-byte EVM address (42 characters)';
      },
    });
    if (clack.isCancel(answer)) {
      clack.cancel('Aborted.');
      return undefined;
    }
    merchantPayTo = answer;
  }

  clack.outro('Configuration answers collected.');

  return { backendBaseUrl, resources, protocols, x402Enabled, merchantPayTo };
}

/** `agent-commerce init [--yes] [--force] [--output <path>]`. */
export async function runInit(options: InitOptions, io: Io, deps: InitDeps = {}): Promise<number> {
  const outputPath = options.outputPath ?? DEFAULT_CONFIG_FILENAME;
  const loadConfig = deps.loadConfig ?? loadConfigDynamic;
  const parseConfigInMemory = deps.parseConfig ?? parseConfigDynamic;
  const fileExists = deps.fileExists ?? existsSync;
  const writeFileImpl =
    deps.writeFile ??
    (async (path: string, content: string) => {
      await writeFile(path, content, 'utf8');
    });

  if (fileExists(outputPath) && options.force !== true) {
    io.stderr(`FAIL  ${outputPath} already exists. Re-run with --force to overwrite.`);
    return 1;
  }

  const answers =
    options.yes === true
      ? defaultInitAnswers()
      : await (deps.collectAnswers ?? collectAnswersInteractive)();

  if (answers === undefined) {
    io.stderr('FAIL  init aborted, nothing was written.');
    return 1;
  }

  // Validate BEFORE writing. Interactive answers can legitimately fail
  // validation — an empty protocol multiselect, a typo'd settlement address,
  // a scheme-less backend URL — and writing first would print "PASS Wrote …"
  // and then blame the tool: "please report this as a bug". Nothing is
  // written unless it is valid, and the message is the real configuration
  // error, which names the field the user can fix.
  let config: GatewayConfig;
  try {
    config = await parseConfigInMemory(buildInitConfigObject(answers));
  } catch (err) {
    io.stderr(formatConfigError(err));
    io.stderr(`FAIL  Nothing was written to ${outputPath}.`);
    return 1;
  }

  const yamlContent = renderInitConfigYaml(answers);
  const resolvedPath = resolve(outputPath);
  const dir = dirname(resolvedPath);
  if (dir !== '' && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  await writeFileImpl(outputPath, yamlContent);
  io.stdout(`PASS  Wrote ${outputPath}`);
  io.stdout(`PASS  ${outputPath} is valid — ${config.resources.length} resource(s)`);

  // The YAML is rendered from the very object just validated, but it is
  // rendered, not serialised from it — so read it back and confirm the two
  // agree. A renderer bug is the one failure the in-memory check cannot see,
  // and it IS a bug worth reporting.
  try {
    await loadConfig({ path: outputPath });
  } catch (err) {
    io.stderr(formatConfigError(err));
    io.stderr(
      `FAIL  ${outputPath} was written but does not parse, although the same answers validated in memory — this is a bug in the config renderer, please report it.`,
    );
    return 1;
  }

  io.stdout('');
  io.stdout('Next steps:');
  io.stdout(`  agent-commerce validate --config ${outputPath}`);
  // Only commands the reader can actually run. `npm run dev:merchant` and
  // `npm run dev:gateway` exist solely inside the development repo, and this
  // CLI ships to npm — telling an installed user to run them is a dead end.
  io.stdout('  docker compose up     # start the local demo stack (from a repo clone)');
  io.stdout(`  agent-commerce doctor --config ${outputPath}`);

  return 0;
}
