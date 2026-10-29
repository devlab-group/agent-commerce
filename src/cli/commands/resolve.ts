/**
 * `agent-commerce resolve` records an operator's verdict on an unresolved
 * payment attempt, then tries to update its authorization hold. It opens the
 * receipt database directly and works while the gateway is stopped.
 * Exit 0 means the resolution was written; 1 means a refusal or error.
 */
import { isCommerceError, systemClock } from '../../core';
import { redactedErrorText } from '../../core/errors';
import { type ConfigLoader, loadConfigDynamic } from '../lib/config-client';
import type { Io } from '../lib/io';
import { osUser, stderrLogger, withJournal } from './reconcile';
import { formatConfigError } from './validate';

// Input and lookup errors whose messages can be shown directly
const OPERATOR_ERRORS: ReadonlySet<string> = new Set(['INPUT_INVALID', 'RESOURCE_NOT_FOUND']);

export interface ResolveOptions {
  readonly configPath?: string;
  readonly status: string;
  readonly reason: string;
  readonly reference?: string;
  readonly actor?: string;
  readonly confirmExpired?: boolean;
}

export interface ResolveDeps {
  readonly loadConfig?: ConfigLoader;
}

export async function runResolveCommand(
  attemptId: string,
  options: ResolveOptions,
  io: Io,
  deps: ResolveDeps = {},
): Promise<number> {
  let config: Awaited<ReturnType<ConfigLoader>>;
  try {
    config = await (deps.loadConfig ?? loadConfigDynamic)(
      options.configPath !== undefined ? { path: options.configPath } : {},
    );
  } catch (error) {
    io.stderr(formatConfigError(error, false, false));
    return 1;
  }

  try {
    const { resolveManually } = await import('../../core/execution/reconcile');
    const logger = stderrLogger(io);
    let code = 1;
    await withJournal(config, logger, async (store, authorizationProviders) => {
      const result = await resolveManually({
        store,
        authorizationProviders,
        clock: systemClock,
        logger,
        attemptId,
        status: options.status,
        actor: options.actor ?? osUser(),
        reason: options.reason,
        ...(options.reference !== undefined ? { externalReference: options.reference } : {}),
        ...(options.confirmExpired === true ? { confirmExpired: true } : {}),
      });
      if (!result.resolved) {
        const hint = result.refusal === 'expiry_unknown' ? ' (pass --confirm-expired)' : '';
        io.stderr(
          `FAIL  ${attemptId} not resolved: ${result.message}${hint} [${result.refusal}, status=${result.attempt.status}]`,
        );
        return;
      }
      io.stdout(`RESOLVED  ${attemptId} status=${result.attempt.status}`);
      const { hold } = result;
      if (hold !== undefined) {
        io.stdout(
          hold.written
            ? `HOLD      ${hold.method} ${hold.hold}`
            : `WARN  ${hold.method} hold not ${hold.hold} (${hold.reason}); agent-commerce reconcile aligns it once the provider is available`,
        );
      }
      code = 0;
    });
    return code;
  } catch (error) {
    io.stderr(
      isCommerceError(error) && OPERATOR_ERRORS.has(error.code)
        ? `FAIL  ${error.code}: ${error.message}`
        : `FAIL  resolve could not run: ${redactedErrorText(error)}`,
    );
    return 1;
  }
}
