/**
 * Local development: fills the `X402_*` and `MERCHANT_WALLET` placeholders in
 * `config.yaml` from `.deploy/local.json` (written by `npm run chain:deploy`)
 * when the shell has not set them.
 *
 * Inside `docker compose`, `docker/gateway-entrypoint.sh` exports these from
 * the manifest before the gateway starts. Host-side `validate` and `doctor`
 * have no such step, so without this the config that starts the container
 * fails on the host with "Unresolved environment variable". See
 * docs/contracts.md, "Local chain deployment manifest".
 *
 * Only unset variables are filled, so a real environment always wins, and only
 * `validate` and `doctor` call this: the config loader and gateway startup
 * never do.
 */
// The narrow module, not the `testing.ts` barrel: the barrel also re-exports
// the deploy engine, which imports `viem`, an optional peer.
// esbuild keeps a bare `import 'viem'` even when the bindings are tree-shaken,
// and the CLI would then refuse to start on a default install.
import {
  LOCAL_CHAIN_MANIFEST_PATH,
  type LocalChainManifest,
  readLocalChainManifest,
} from '../../payments/x402/local-chain/manifest';

export { LOCAL_CHAIN_MANIFEST_PATH };

// `config.yaml` placeholder name -> the manifest field it fills
const MANIFEST_ENV_VARS: readonly (readonly [string, (m: LocalChainManifest) => string])[] = [
  ['X402_ASSET', (m) => m.asset],
  ['X402_ASSET_NAME', (m) => m.assetName],
  ['X402_ASSET_VERSION', (m) => m.assetVersion],
  ['X402_ASSET_DECIMALS', (m) => String(m.assetDecimals)],
  ['MERCHANT_WALLET', (m) => m.merchant.address],
  ['X402_FACILITATOR_PRIVATE_KEY', (m) => m.facilitator.privateKey],
];

/** Names of the variables this module can fill, for matching an unresolved variable */
export const MANIFEST_FILLABLE_ENV_VAR_NAMES: ReadonlySet<string> = new Set(
  MANIFEST_ENV_VARS.map(([name]) => name),
);

export interface ManifestEnvFill {
  /** `baseEnv` plus any filled variables. `baseEnv` itself is never mutated */
  readonly env: NodeJS.ProcessEnv;
  /** Names actually filled - empty when the manifest was absent or invalid, or nothing needed filling */
  readonly filled: readonly string[];
  /** True when a valid manifest was read, whether or not anything needed filling */
  readonly manifestFound: boolean;
}

/**
 * Reads `.deploy/local.json` under `cwd` and fills the unset variables in
 * {@link MANIFEST_ENV_VARS}. Never throws: with a missing or invalid manifest
 * nothing is filled, and `src/config` reports the unresolved variable as usual.
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
