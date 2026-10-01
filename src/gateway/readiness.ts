/**
 * `GET /ready`: 503 when the store, a protocol adapter, or a payment or
 * authorization provider reports `fail`; `warn` still counts as serving.
 * Providers count because a payment provider that cannot reach its RPC would
 * otherwise leave the gateway ready while it serves 402 challenges it cannot
 * honor.
 *
 * The route is unauthenticated, so a health `detail` or a thrown message never
 * reaches the client, only a fixed vocabulary.
 *
 * An evaluation calls every dependency's `health()`, some of which make
 * upstream RPC calls. `createReadinessProbe` memoizes it for
 * READINESS_TTL_MS and collapses concurrent callers onto one evaluation, which
 * `/ready` and `/.well-known/agent-commerce` share.
 */
import type {
  AdapterDescriptor,
  AdapterHealth,
  AuthorizationProvider,
  Clock,
  Logger,
  PaymentProvider,
  ReceiptStore,
} from '../core';
import { type AdapterRuntime, getAdapterHealth } from './adapters';

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

export interface ProbedAdapter {
  readonly descriptor: AdapterDescriptor;
  readonly health: AdapterHealth;
}

// The client-facing detail per status; `threw` covers a health() that threw
// and defaults to the `fail` detail
type HealthDetails = Readonly<Record<AdapterHealth['status'], string | undefined>> & {
  readonly threw?: string;
};

const STORE_DETAIL: HealthDetails = {
  pass: undefined,
  warn: 'store-degraded',
  fail: 'store-unwritable',
  threw: 'store-unreachable',
};

const ADAPTER_DETAIL: HealthDetails = {
  pass: undefined,
  warn: 'adapter-degraded',
  fail: 'adapter-unreachable',
};

const PAYMENT_PROVIDER_DETAIL: HealthDetails = {
  pass: undefined,
  warn: 'payment-provider-degraded',
  fail: 'payment-provider-unreachable',
};

const AUTHORIZATION_PROVIDER_DETAIL: HealthDetails = {
  pass: undefined,
  warn: 'authorization-provider-degraded',
  fail: 'authorization-provider-unreachable',
};

// A readiness check plus the health it came from, detail included. Only the
// check reaches /ready; the well-known document publishes adapter health
// without its detail.
interface Probed {
  readonly check: ReadinessCheck;
  readonly health: AdapterHealth;
}

/**
 * One probe for the store, the adapters and both provider kinds. A `health()`
 * that throws counts as failing and is logged at error; a returned detail is
 * logged at debug.
 */
async function probe(
  target: { readonly name: string; health(): Promise<AdapterHealth> },
  kind: string,
  details: HealthDetails,
  options: Pick<CheckReadinessOptions, 'clock' | 'logger'>,
): Promise<Probed> {
  let health: AdapterHealth;
  let threw = false;
  try {
    health = await target.health();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.logger.error({ err: message, name: target.name }, `${kind} health() threw`);
    health = { status: 'fail', checkedAt: options.clock.nowIso() };
    threw = true;
  }
  if (health.detail !== undefined) {
    options.logger.debug(
      { name: target.name, detail: health.detail },
      `${kind} health detail (not sent to the client)`,
    );
  }
  const detail = threw ? (details.threw ?? details.fail) : details[health.status];
  return {
    check: {
      name: target.name,
      status: health.status,
      ...(detail !== undefined ? { detail } : {}),
    },
    health,
  };
}

interface Evaluation {
  readonly result: ReadinessResult;
  readonly adapters: readonly ProbedAdapter[];
}

async function evaluate(options: CheckReadinessOptions): Promise<Evaluation> {
  const [store, adapters, paymentProviders, authorizationProviders] = await Promise.all([
    probe({ name: 'store', health: () => options.store.health() }, 'store', STORE_DETAIL, options),
    Promise.all(
      options.adapterRuntimes.map(async (runtime) => ({
        runtime,
        probed: await probe(
          // getAdapterHealth turns a throw into a failed result, so an adapter
          // failure is logged at debug as a detail rather than at error
          { name: runtime.adapter.name, health: () => getAdapterHealth(runtime, options.clock) },
          'adapter',
          ADAPTER_DETAIL,
          options,
        ),
      })),
    ),
    Promise.all(
      options.paymentProviders.map((provider) =>
        probe(provider, 'payment provider', PAYMENT_PROVIDER_DETAIL, options),
      ),
    ),
    // An unusable authorization provider blocks readiness on the same threshold
    // as a payment one: a resource that requires a mandate cannot be served
    // without it, and serving the challenge anyway promises what we cannot honor
    Promise.all(
      options.authorizationProviders.map((provider) =>
        probe(provider, 'authorization provider', AUTHORIZATION_PROVIDER_DETAIL, options),
      ),
    ),
  ]);

  const checks = [
    store,
    ...adapters.map((a) => a.probed),
    ...paymentProviders,
    ...authorizationProviders,
  ];
  return {
    result: {
      ready: checks.every((probed) => probed.check.status !== 'fail'),
      store: store.check,
      adapters: adapters.map((a) => a.probed.check),
      paymentProviders: paymentProviders.map((p) => p.check),
      authorizationProviders: authorizationProviders.map((p) => p.check),
    },
    adapters: adapters.map(({ runtime, probed }) => ({
      descriptor: runtime.adapter.descriptor,
      health: probed.health,
    })),
  };
}

// Short enough that an outage or a recovery shows within one window
const READINESS_TTL_MS = 2_000;

export interface ReadinessProbe {
  check(): Promise<ReadinessResult>;
  /** Every adapter's health from the same memoized evaluation, detail included */
  adapterHealth(): Promise<readonly ProbedAdapter[]>;
}

export function createReadinessProbe(
  options: CheckReadinessOptions,
  ttlMs: number = READINESS_TTL_MS,
): ReadinessProbe {
  let cached: { readonly evaluation: Evaluation; readonly at: number } | undefined;
  let inFlight: Promise<Evaluation> | undefined;

  const current = async (): Promise<Evaluation> => {
    const now = options.clock.monotonicMs();
    if (cached && now - cached.at < ttlMs) return cached.evaluation;
    if (inFlight) return inFlight;

    inFlight = evaluate(options)
      .then((evaluation) => {
        cached = { evaluation, at: options.clock.monotonicMs() };
        return evaluation;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  return {
    check: async () => (await current()).result,
    adapterHealth: async () => (await current()).adapters,
  };
}
