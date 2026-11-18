// The report doctor builds, and what a caller can inject
import type { ReceiptStore } from '../../../core';
import type { SqliteReceiptStore } from '../../../storage/receipts';
import type { ConfigFileReader, ConfigLoader } from '../../lib/config-client';
import type { FetchJsonResult, FetchLike } from '../../lib/http';
import type { ManifestEnvFill } from '../../lib/manifest-env';
import type { LoadViemAccounts } from './payments';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'INFO';

/**
 * Why a check could not reach a verdict: `unreachable` for a recognized
 * transport failure, or `skipped` for a failed prerequisite. The marker does
 * not affect the check's status, the score or the exit code.
 */
export type Undetermined = 'unreachable' | 'skipped';

export interface DoctorCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** Absent on a result that is a verdict */
  readonly undetermined?: Undetermined;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly score: { readonly passed: number; readonly total: number };
  readonly exitCode: number;
}

export interface DoctorOptions {
  readonly configPath?: string;
  readonly gatewayUrl?: string;
  /** Experimental. Adds a Registry check; queries the public registry when config yields a listing */
  readonly registry?: boolean;
}

/** A receipt store for doctor to read; `summary` adds the journal and import checks */
export type DoctorStore = ReceiptStore & { readonly summary?: SqliteReceiptStore['summary'] };

export interface DoctorDeps {
  readonly fetchImpl?: FetchLike;
  readonly loadConfig?: ConfigLoader;
  /**
   * Reads raw config for the Secrets check. The default reader is used only
   * when neither this reader nor `loadConfig` is injected; an injected loader
   * without a reader skips the check.
   */
  readonly readConfigFile?: ConfigFileReader;
  readonly createStore?: (path: string) => DoctorStore;
  readonly fillEnvFromManifest?: (env: NodeJS.ProcessEnv) => ManifestEnvFill;
  readonly hasChainDeployScript?: () => boolean;
  readonly loadViemAccounts?: LoadViemAccounts;
}

export type WellKnownResult = FetchJsonResult<Record<string, unknown>>;

/** Returns `{ undetermined }` when a reason is given, otherwise an empty object */
export function undeterminedField(reason: Undetermined | undefined): {
  readonly undetermined?: Undetermined;
} {
  return reason !== undefined ? { undetermined: reason } : {};
}

/** The fields of a check that did not run because config failed to load */
export const SKIPPED_CONFIG_INVALID = {
  detail: 'skipped: config invalid',
  undetermined: 'skipped',
} as const;
