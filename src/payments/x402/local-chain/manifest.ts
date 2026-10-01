/**
 * The `.deploy/local.json` deployment manifest, whose shape docs/contracts.md
 * documents. The demo and CLI read the local MockUSDC address through
 * `readLocalChainManifest()` instead of hard-coding it.
 *
 * Imports no optional peer (zod is a regular dependency), so the CLI can load it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CommerceError } from '../../../core';

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
   * The same chain as reached from the host. It differs from `rpcUrl` only when
   * the deployer ran inside Docker, where `rpcUrl` is a container address such
   * as "http://anvil:8545". Host-side consumers use `hostRpcUrl ?? rpcUrl`.
   * Optional so older manifests still parse.
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

const nonEmpty = z.string().min(1, 'must be a non-empty string');
const keyedAccount = z.object({ address: z.string(), privateKey: z.string(), note: z.string() });

const MANIFEST_SCHEMA = z.object({
  chainId: z.number(),
  rpcUrl: nonEmpty,
  hostRpcUrl: nonEmpty.optional(),
  asset: nonEmpty,
  assetName: nonEmpty,
  assetVersion: nonEmpty,
  assetDecimals: z.number(),
  merchant: z.object({ address: z.string(), privateKeyLabel: z.string() }),
  buyer: keyedAccount,
  facilitator: keyedAccount,
  buyerInitialBalance: nonEmpty,
});

/**
 * Reads and structurally validates `.deploy/local.json`. Throws an actionable
 * error if it is missing or malformed, and no caller falls back to a
 * hard-coded address.
 */
export function readLocalChainManifest(cwd: string = process.cwd()): LocalChainManifest {
  const path = join(cwd, LOCAL_CHAIN_MANIFEST_PATH);

  if (!existsSync(path)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Local chain manifest not found at "${path}". Run "npm run chain:start" then "npm run chain:deploy" first.`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new CommerceError('CONFIG_INVALID', `Could not read local chain manifest at "${path}".`, {
      cause,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Local chain manifest at "${path}" is not valid JSON. Re-run "npm run chain:deploy" to regenerate it.`,
      { cause },
    );
  }

  const result = MANIFEST_SCHEMA.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new CommerceError(
      'CONFIG_INVALID',
      `Local chain manifest at "${path}" is invalid: ${where}${issue?.message ?? 'unexpected shape'}. ` +
        'Re-run "npm run chain:deploy".',
    );
  }
  return result.data as LocalChainManifest;
}
