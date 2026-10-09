/**
 * `config.yaml` schema, validation and normalization into the canonical
 * `GatewayConfig` (docs/contracts.md).
 *
 * 1. Zod validates shape: types, required fields, unknown keys. Numeric and
 *    boolean leaves accept their native type or a string, because env
 *    substitution produces strings. Zod transforms interact badly with
 *    `.strict()` inference, so coercion happens in plain TypeScript in step 2.
 * 2. A business-rule pass coerces those leaves and checks what needs a
 *    specific message: cross-references, disabled protocols and payment
 *    methods, dynamic pricing, addresses, duplicate trust entries.
 *
 * Env substitution (`${VAR}` / `${VAR:-default}`) runs over the raw value
 * before both steps, so numeric and boolean fields can be templated. The one
 * exception is `version:`, checked before substitution: it decides whether this
 * parser understands the document at all, so it cannot depend on the
 * environment.
 */
import type { ZodError, ZodIssue, z } from 'zod';
import { CommerceError } from '../../core';
import { isRecord } from '../../core/is-record';
import { substituteEnv } from '../env';
import { normalize } from './normalize';
import { RawConfigSchema, SUPPORTED_CONFIG_VERSION } from './raw';
import type { GatewayConfig } from './types';

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv): GatewayConfig {
  if (!isRecord(raw)) {
    throw new CommerceError(
      'CONFIG_INVALID',
      'Configuration root must be a mapping (object) at "$"',
      {
        details: { path: '$' },
      },
    );
  }

  checkVersion(raw);

  const substituted = substituteEnv(raw, env);
  const parsed = parseWithZod(RawConfigSchema, substituted);
  return normalize(parsed);
}

function checkVersion(raw: Record<string, unknown>): void {
  if (!('version' in raw)) {
    throw new CommerceError('CONFIG_INVALID', 'Configuration is missing required field "version"', {
      details: { path: 'version' },
    });
  }
  const version = raw['version'];
  if (version !== SUPPORTED_CONFIG_VERSION) {
    const hint = typeof version === 'string' ? ', written as a number without quotes' : '';
    throw new CommerceError(
      'CONFIG_INVALID',
      `Unsupported config version "${String(version)}": this gateway only supports version ${SUPPORTED_CONFIG_VERSION}${hint}`,
      { details: { path: 'version', supported: SUPPORTED_CONFIG_VERSION } },
    );
  }
}

function parseWithZod<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw zodErrorToConfigError(result.error);
  }
  return result.data;
}

function zodErrorToConfigError(error: ZodError): CommerceError {
  const issues = error.issues.map(describeIssue);
  const first = issues[0];
  const message = first
    ? `Configuration invalid at "${first.path}": ${first.message}`
    : 'Configuration invalid';
  return new CommerceError('CONFIG_INVALID', message, { details: { issues } });
}

function describeIssue(issue: ZodIssue): { path: string; message: string; code: string } {
  const path = issue.path.length > 0 ? issue.path.join('.') : '$';
  return { path, message: issue.message, code: issue.code };
}

export type {
  AcpDiscoveryConfig,
  AcpProtocolConfig,
  GatewayConfig,
  X402OptionConfig,
} from './types';
