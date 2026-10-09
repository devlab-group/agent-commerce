// The report doctor builds, and what a caller can inject
import type { ReceiptStore } from '../../../core';
import type { ConfigLoader } from '../../lib/config-client';
import type { FetchJsonResult, FetchLike } from '../../lib/http';
import type { ManifestEnvFill } from '../../lib/manifest-env';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'INFO';

export interface DoctorCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly score: { readonly passed: number; readonly total: number };
  readonly exitCode: number;
}

export interface DoctorOptions {
  readonly configPath?: string;
  readonly gatewayUrl?: string;
}

export interface DoctorDeps {
  readonly fetchImpl?: FetchLike;
  readonly loadConfig?: ConfigLoader;
  readonly createStore?: (path: string) => ReceiptStore;
  readonly fillEnvFromManifest?: (env: NodeJS.ProcessEnv) => ManifestEnvFill;
}

export type WellKnownResult = FetchJsonResult<Record<string, unknown>>;
