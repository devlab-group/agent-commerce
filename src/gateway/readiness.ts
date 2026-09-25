/**
 * `GET /ready` readiness computation: 503 unless the store, every configured
 * protocol adapter, every payment provider AND every authorization provider
 * are healthy. `status: 'warn'` is treated as still-serving (degraded); only
 * `status: 'fail'` blocks readiness — applied uniformly to all four kinds of
 * dependency.
 *
 * Payment providers are consulted here alongside the store and protocol
 * adapters: without that, a gateway whose x402 RPC is unreachable reports
 * `ready: true` and goes on serving 402 challenges it cannot honour. `fail`, not `warn`, blocks readiness for a provider — same
 * threshold as the store and adapters, not a special case: a broken payment
 * provider is not "degraded but serving", it is a broken core promise for
 * every resource that requires payment, exactly like a store that cannot
 * record or a required adapter that cannot route.
 *
 * A health result's raw `detail`, or a thrown error's message, is internal and
 * must stay off this unauthenticated route. The client sees a small fixed
 * vocabulary. Returned details are logged at debug; store and provider throws
 * are logged at error, while adapter throws become failed results logged at
 * debug.
 *
 * `/ready` is itself unauthenticated, with no cache and no rate
 * limit, and `checkReadiness` calls every dependency's `health()` fresh on
 * every request — on a commercial RPC provider that is a live, billed
 * upstream call an attacker spends for free (measured: 20 requests -> 60
 * upstream JSON-RPC calls). `createReadinessProbe` memoises the result for
 * READINESS_TTL_MS and collapses concurrent callers onto one in-flight
 * evaluation, so a burst of N requests produces at most one real check.
 */
import type {
  AdapterHealth,
  AuthorizationProvider,
  Clock,
  Logger,
  PaymentProvider,
  ReceiptStore,
} from '../core/index.js';
import { type AdapterRuntime, getAdapterHealth } from './adapters.js';

export interface ReadinessCheck {
  readonly name: string;
  readonly status: AdapterHealth['status'];
  readonly detail?: string;
}

export interface ReadinessResult {
  readonly ready: boolean;
  readonly store: ReadinessCheck;
  readonly adapters: readonly ReadinessCheck[];
  readonly paymentProviders: readonly ReadinessCheck[];
  readonly authorizationProviders: readonly ReadinessCheck[];
}

export interface CheckReadinessOptions {
  readonly store: ReceiptStore;
  readonly adapterRuntimes: readonly AdapterRuntime[];
  readonly paymentProviders: readonly PaymentProvider[];
  readonly authorizationProviders: readonly AuthorizationProvider[];
  readonly clock: Clock;
  readonly logger: Logger;
}

const STORE_DETAIL: Readonly<Record<AdapterHealth['status'], string | undefined>> = {
  pass: undefined,
  warn: 'store-degraded',
  fail: 'store-unwritable',
};

const ADAPTER_DETAIL: Readonly<Record<AdapterHealth['status'], string | undefined>> = {
  pass: undefined,
  warn: 'adapter-degraded',
  fail: 'adapter-unreachable',
};

const PAYMENT_PROVIDER_DETAIL: Readonly<Record<AdapterHealth['status'], string | undefined>> = {
  pass: undefined,
  warn: 'payment-provider-degraded',
  fail: 'payment-provider-unreachable',
};

const AUTHORIZATION_PROVIDER_DETAIL: Readonly<Record<AdapterHealth['status'], string | undefined>> =
  {
    pass: undefined,
    warn: 'authorization-provider-degraded',
    fail: 'authorization-provider-unreachable',
  };

/**
 * One probe for both provider kinds. A provider whose `health()` throws told us
 * nothing, so it counts as failing rather than as absent, and only the fixed
 * vocabulary above reaches the client.
 */
async function probeProvider(
  provider: { readonly name: string; health(): Promise<AdapterHealth> },
  kind: string,
  details: Readonly<Record<AdapterHealth['status'], string | undefined>>,
  options: Pick<CheckReadinessOptions, 'clock' | 'logger'>,
): Promise<ReadinessCheck> {
  let health: AdapterHealth;
  try {
    health = await provider.health();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.logger.error({ err: message, provider: provider.name }, `${kind} health() threw`);
    health = { status: 'fail', checkedAt: options.clock.nowIso() };
  }
  if (health.detail !== undefined) {
    options.logger.debug(
      { provider: provider.name, detail: health.detail },
      `${kind} health detail (not sent to the client)`,
    );
  }
  const detail = details[health.status];
  return {
    name: provider.name,
    status: health.status,
    ...(detail !== undefined ? { detail } : {}),
  };
}

export async function checkReadiness(options: CheckReadinessOptions): Promise<ReadinessResult> {
  let storeHealth: AdapterHealth;
  let storeThrew = false;
  try {
    storeHealth = await options.store.health();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.logger.error({ err: message }, 'store.health() threw');
    storeHealth = { status: 'fail', checkedAt: options.clock.nowIso() };
    storeThrew = true;
  }
  if (storeHealth.detail !== undefined) {
    options.logger.debug(
      { detail: storeHealth.detail },
      'store health detail (not sent to the client)',
    );
  }

  const adapterChecks = await Promise.all(
    options.adapterRuntimes.map(async (runtime): Promise<ReadinessCheck> => {
      const health = await getAdapterHealth(runtime, options.clock);
      if (health.detail !== undefined) {
        options.logger.debug(
          { adapter: runtime.adapter.name, detail: health.detail },
          'adapter health detail (not sent to the client)',
        );
      }
      const detail = ADAPTER_DETAIL[health.status];
      return {
        name: runtime.adapter.name,
        status: health.status,
        ...(detail !== undefined ? { detail } : {}),
      };
    }),
  );

  const paymentProviderChecks = await Promise.all(
    options.paymentProviders.map((provider) =>
      probeProvider(provider, 'payment provider', PAYMENT_PROVIDER_DETAIL, options),
    ),
  );

  // An unusable authorization provider blocks readiness on the same threshold
  // as a payment one: a resource that requires a mandate cannot be served
  // without it, and serving the challenge anyway promises what we cannot honour
  const authorizationProviderChecks = await Promise.all(
    options.authorizationProviders.map((provider) =>
      probeProvider(provider, 'authorization provider', AUTHORIZATION_PROVIDER_DETAIL, options),
    ),
  );

  const storeReady = storeHealth.status !== 'fail';
  const adaptersReady = adapterChecks.every((check) => check.status !== 'fail');
  const paymentProvidersReady = paymentProviderChecks.every((check) => check.status !== 'fail');
  const authorizationProvidersReady = authorizationProviderChecks.every(
    (check) => check.status !== 'fail',
  );
  const storeDetail = storeThrew ? 'store-unreachable' : STORE_DETAIL[storeHealth.status];

  return {
    ready: storeReady && adaptersReady && paymentProvidersReady && authorizationProvidersReady,
    store: {
      name: 'store',
      status: storeHealth.status,
      ...(storeDetail !== undefined ? { detail: storeDetail } : {}),
    },
    adapters: adapterChecks,
    paymentProviders: paymentProviderChecks,
    authorizationProviders: authorizationProviderChecks,
  };
}

/** A readiness probe does not need sub-second freshness: a real outage is
 * still caught within one TTL window, and this is short enough that a burst
 * of requests during a genuine state change (e.g. right after startup) isn't
 * stuck looking at a stale answer for long. */
export const READINESS_TTL_MS = 2_000;

export interface ReadinessProbe {
  check(): Promise<ReadinessResult>;
}

export function createReadinessProbe(
  options: CheckReadinessOptions,
  ttlMs: number = READINESS_TTL_MS,
): ReadinessProbe {
  let cached: { readonly result: ReadinessResult; readonly at: number } | undefined;
  let inFlight: Promise<ReadinessResult> | undefined;

  return {
    async check(): Promise<ReadinessResult> {
      const now = options.clock.monotonicMs();
      if (cached && now - cached.at < ttlMs) return cached.result;
      if (inFlight) return inFlight;

      inFlight = checkReadiness(options)
        .then((result) => {
          cached = { result, at: options.clock.monotonicMs() };
          return result;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
  };
}
