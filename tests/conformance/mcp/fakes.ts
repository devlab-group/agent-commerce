/**
 * Fake ExecutionPipeline / ResourceRegistry / runtime primitives used to
 * drive the MCP adapter in isolation. No dependency on gateway, config or
 * payment-x402 — only the frozen `src/core` contract.
 */
import {
  type CanonicalRequest,
  type Clock,
  type CommerceResource,
  type EventSink,
  type ExecutionOutcome,
  type ExecutionPipeline,
  type IdGenerator,
  type Logger,
  NOOP_LOGGER,
  type ProtocolAdapterContext,
  type ProtocolName,
  type ResourceRegistry,
} from '../../../src/core/index.js';

/**
 * Records every `CanonicalRequest` it receives and delegates the outcome (or
 * thrown error) to a test-supplied handler. Defaults to throwing, so a test
 * that forgets to configure a handler fails loudly instead of hanging.
 */
export class FakeExecutionPipeline implements ExecutionPipeline {
  readonly requests: CanonicalRequest[] = [];
  handler: (request: CanonicalRequest) => ExecutionOutcome | Promise<ExecutionOutcome> = () => {
    throw new Error('FakeExecutionPipeline: no handler configured for this test');
  };

  async execute(request: CanonicalRequest): Promise<ExecutionOutcome> {
    this.requests.push(request);
    return this.handler(request);
  }

  get lastRequest(): CanonicalRequest | undefined {
    return this.requests.at(-1);
  }
}

export class FakeResourceRegistry implements ResourceRegistry {
  constructor(private readonly resources: readonly CommerceResource[]) {}

  get(id: string): CommerceResource | undefined {
    return this.resources.find((r) => r.id === id);
  }

  list(): readonly CommerceResource[] {
    return this.resources;
  }

  has(id: string): boolean {
    return this.resources.some((r) => r.id === id);
  }

  listExposedVia(protocol: ProtocolName): readonly CommerceResource[] {
    return this.resources.filter((r) => r.exposedVia.includes(protocol));
  }
}

export function createFakeClock(iso = '2026-07-12T00:00:00.000Z'): Clock {
  return {
    now: () => new Date(iso),
    nowIso: () => iso,
    monotonicMs: () => 0,
  };
}

export function createFakeIds(prefix = 'test'): IdGenerator {
  let counter = 0;
  return {
    next: (p) => `${p ?? prefix}-${++counter}`,
  };
}

const NOOP_EVENTS: EventSink = {
  emit: async () => {},
};

export interface FakeContextOptions {
  readonly resources: readonly CommerceResource[];
  readonly logger?: Logger;
  readonly publicBaseUrl?: string;
}

export interface FakeContextHandle {
  readonly context: ProtocolAdapterContext;
  readonly pipeline: FakeExecutionPipeline;
}

export function createFakeContext(options: FakeContextOptions): FakeContextHandle {
  const pipeline = new FakeExecutionPipeline();
  const context: ProtocolAdapterContext = {
    pipeline,
    resources: new FakeResourceRegistry(options.resources),
    events: NOOP_EVENTS,
    logger: options.logger ?? NOOP_LOGGER,
    clock: createFakeClock(),
    ids: createFakeIds(),
    publicBaseUrl: options.publicBaseUrl ?? 'http://127.0.0.1:8080',
  };
  return { context, pipeline };
}
