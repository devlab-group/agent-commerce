// Secrets: every `${VAR}` placeholder in the raw config, by name and never by value

import { listEnvPlaceholders } from '../../../config/env';
import type { ConfigFileReader } from '../../lib/config-client';
import type { DoctorCheck } from './types';

/**
 * List all missing config variables; config loading stops at the first.
 * Return names only, since values and defaults may contain credentials.
 */
export async function secretsCheck(
  read: ConfigFileReader,
  path: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<DoctorCheck> {
  let raw: unknown;
  try {
    raw = await read({ ...(path !== undefined ? { path } : {}), env });
  } catch {
    // The Config check reports why
    return {
      name: 'Secrets',
      status: 'WARN',
      detail: 'skipped: config file unreadable',
      undetermined: 'skipped',
    };
  }
  const { missing, set, defaulted } = listEnvPlaceholders(raw, env);
  const groups = [
    ...(missing.length > 0 ? [`${missing.length} missing (${missing.join(', ')})`] : []),
    ...(set.length > 0 ? [`${set.length} set (${set.join(', ')})`] : []),
    ...(defaulted.length > 0 ? [`${defaulted.length} defaulted (${defaulted.join(', ')})`] : []),
  ];
  if (groups.length === 0) {
    return { name: 'Secrets', status: 'INFO', detail: 'config reads no environment variable' };
  }
  return {
    name: 'Secrets',
    status: missing.length > 0 ? 'FAIL' : 'PASS',
    detail: groups.join('; '),
  };
}
