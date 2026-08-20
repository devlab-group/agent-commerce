/**
 * Local-development convenience: fills `X402_*`/`MERCHANT_WALLET`
 * placeholders in `config.yaml` from `.deploy/local.json` (written
 * by `npm run chain:deploy`) when the host shell hasn't set them itself.
 *
 * Why this exists: inside `docker compose`, `docker/gateway-entrypoint.sh`
 * exports these from the manifest before the gateway process starts. Running
 * `agent-commerce validate`/`doctor` on the host has no equivalent step, so
 * the exact same config that starts the (containerised) gateway fine fails
 * host-side with "Unresolved environment variable" — reporting a healthy
 * stack as broken. See docs/contracts.md "Local chain deployment manifest".
 *
 * Deliberately narrow: only fills a variable that is completely unset (a
 * real environment always wins — this can never override a deployment), only
 * from the exact fields the manifest declares, and only for `validate`/
 * `doctor` — never inside the config loader itself, so gateway startup is
 * unaffected either way.
 */
// Imported from the narrow module, not the `testing.js` barrel: that barrel
// also re-exports the Anvil bootstrap and the deploy engine, which import
// `viem`. Tree-shaking drops the unused bindings but esbuild still emits a
// bare `import 'viem'` for side effects, and viem is an optional peer — the
// CLI would refuse to start on a default install. Caught by a bare
// clean-consumer install, not by any in-repo test.
import {
  LOCAL_CHAIN_MANIFEST_PATH,
  type LocalChainManifest,
  readLocalChainManifest,
} from '../../payments/x402/local-chain/manifest.js';

export { LOCAL_CHAIN_MANIFEST_PATH };

/** `config.yaml` placeholder name -> the manifest field it maps to. */
const MANIFEST_ENV_VARS: readonly (readonly [string, (m: LocalChainManifest) => string])[] = [
  ['X402_ASSET', (m) => m.asset],
  ['X402_ASSET_NAME', (m) => m.assetName],
  ['X402_ASSET_VERSION', (m) => m.assetVersion],
  ['X402_ASSET_DECIMALS', (m) => String(m.assetDecimals)],
  ['MERCHANT_WALLET', (m) => m.merchant.address],
  ['X402_FACILITATOR_PRIVATE_KEY', (m) => m.facilitator.privateKey],
];

/** The subset of {@link MANIFEST_ENV_VARS} names, for checking a failed variable against. */
export const MANIFEST_FILLABLE_ENV_VAR_NAMES: ReadonlySet<string> = new Set(
  MANIFEST_ENV_VARS.map(([name]) => name),
);

export interface ManifestEnvFill {
  /** `baseEnv`, plus any variables filled. Never mutates `baseEnv` itself. */
  readonly env: NodeJS.ProcessEnv;
  /** Names actually filled — empty when the manifest was absent or nothing needed filling. */
  readonly filled: readonly string[];
  /** True once a manifest was found at all, whether or not anything needed filling. */
  readonly manifestFound: boolean;
}

/**
 * Reads `.deploy/local.json` (relative to `cwd`) and fills only the
 * currently-unset variables in {@link MANIFEST_ENV_VARS}. Never throws — a
 * missing or invalid manifest just means nothing gets filled, and the
 * existing "unresolved environment variable" error from `src/config`
 * surfaces exactly as it does today.
 */
export function fillEnvFromLocalChainManifest(
  baseEnv: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
): ManifestEnvFill {
  let manifest: LocalChainManifest;
  try {
    manifest = readLocalChainManifest(cwd);
  } catch {
    return { env: baseEnv, filled: [], manifestFound: false };
  }

  const filled: string[] = [];
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const [name, read] of MANIFEST_ENV_VARS) {
    if (env[name] === undefined) {
      env[name] = read(manifest);
      filled.push(name);
    }
  }
  return { env, filled, manifestFound: true };
}
