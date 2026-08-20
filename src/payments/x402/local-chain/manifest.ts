/**
 * Local chain deployment manifest — read/write contract for `.deploy/local.json`.
 *
 * Exact shape frozen in docs/contracts.md. Everything else in the repo reads
 * chain addresses through `readLocalChainManifest()` — no hard-coded
 * addresses anywhere else.
 *
 * Lives inside `src/payments/x402` (not `scripts/chain`, which is
 * outside `src/` and is run directly by npm scripts —
 * see `deploy-engine.ts`'s header comment for the same reasoning) so any
 * workspace package can import it via `src/payments/x402/testing.ts`
 * (see `docs/contracts.md`, "Local chain deployment manifest"). It has no
 * dependency on viem/zod/x402 regardless — plain Node built-ins only —
 * `scripts/chain/manifest.ts` re-exports this module unchanged so
 * `npm run chain:deploy` keeps working as a thin CLI wrapper.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const LOCAL_CHAIN_MANIFEST_PATH = '.deploy/local.json';

export interface LocalChainManifestMerchant {
  readonly address: string;
  readonly privateKeyLabel: string;
}

export interface LocalChainManifestKeyedAccount {
  readonly address: string;
  readonly privateKey: string;
  readonly note: string;
}

export interface LocalChainManifest {
  readonly chainId: number;
  readonly rpcUrl: string;
  /**
   * The same chain, reachable from the *host* — distinct from `rpcUrl` only
   * when the deployer ran inside a Docker network (there `rpcUrl` is the
   * container-internal address, e.g. "http://anvil:8545", unresolvable from
   * the host). A host deploy records the same value in both fields, since on
   * the host they genuinely are the same endpoint. Host-side consumers
   * (demo agent, CLI) should prefer `hostRpcUrl ?? rpcUrl`. Optional so a
   * manifest written before this field existed still parses.
   */
  readonly hostRpcUrl?: string;
  readonly asset: string;
  readonly assetName: string;
  readonly assetVersion: string;
  readonly assetDecimals: number;
  readonly merchant: LocalChainManifestMerchant;
  readonly buyer: LocalChainManifestKeyedAccount;
  readonly facilitator: LocalChainManifestKeyedAccount;
  readonly buyerInitialBalance: string;
}

const REQUIRED_TOP_LEVEL_STRING_FIELDS = [
  'rpcUrl',
  'asset',
  'assetName',
  'assetVersion',
  'buyerInitialBalance',
] as const;

/**
 * Reads and structurally validates `.deploy/local.json`.
 *
 * Throws a clear, actionable error if the manifest is missing or malformed —
 * every consumer of this function is expected to let that error propagate
 * rather than silently falling back to a hard-coded address.
 */
export function readLocalChainManifest(cwd: string = process.cwd()): LocalChainManifest {
  const path = join(cwd, LOCAL_CHAIN_MANIFEST_PATH);

  if (!existsSync(path)) {
    throw new Error(
      `Local chain manifest not found at "${path}". Run "npm run chain:start" then "npm run chain:deploy" first.`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(`Could not read local chain manifest at "${path}".`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `Local chain manifest at "${path}" is not valid JSON. Re-run "npm run chain:deploy" to regenerate it.`,
      { cause },
    );
  }

  return validateManifestShape(parsed, path);
}

function validateManifestShape(value: unknown, path: string): LocalChainManifest {
  const fail = (detail: string): never => {
    throw new Error(
      `Local chain manifest at "${path}" is invalid: ${detail}. Re-run "npm run chain:deploy".`,
    );
  };

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('expected a JSON object');
  }
  const record = value as Record<string, unknown>;

  if (typeof record.chainId !== 'number') {
    return fail('"chainId" must be a number');
  }
  if (typeof record.assetDecimals !== 'number') {
    return fail('"assetDecimals" must be a number');
  }
  for (const field of REQUIRED_TOP_LEVEL_STRING_FIELDS) {
    if (typeof record[field] !== 'string' || record[field] === '') {
      return fail(`"${field}" must be a non-empty string`);
    }
  }
  // Optional: absent entirely on a manifest written before this field
  // existed, but if present it must be well-formed — never silently ignore a
  // malformed value on a trust-boundary read.
  if ('hostRpcUrl' in record && record.hostRpcUrl !== undefined) {
    if (typeof record.hostRpcUrl !== 'string' || record.hostRpcUrl === '') {
      return fail('"hostRpcUrl" must be a non-empty string when present');
    }
  }

  const merchant = record.merchant;
  if (
    typeof merchant !== 'object' ||
    merchant === null ||
    typeof (merchant as Record<string, unknown>).address !== 'string' ||
    typeof (merchant as Record<string, unknown>).privateKeyLabel !== 'string'
  ) {
    return fail('"merchant" must be { address: string, privateKeyLabel: string }');
  }

  for (const key of ['buyer', 'facilitator'] as const) {
    const account = record[key];
    if (
      typeof account !== 'object' ||
      account === null ||
      typeof (account as Record<string, unknown>).address !== 'string' ||
      typeof (account as Record<string, unknown>).privateKey !== 'string' ||
      typeof (account as Record<string, unknown>).note !== 'string'
    ) {
      return fail(`"${key}" must be { address: string, privateKey: string, note: string }`);
    }
  }

  return record as unknown as LocalChainManifest;
}
