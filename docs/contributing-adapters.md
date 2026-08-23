# Writing an adapter

Two extension points exist, and neither should require changing
`src/core`. If yours does, raise it as a contract change before writing
code — see [contracts.md](contracts.md).

## A protocol adapter

Implement `ProtocolAdapter` (or `HttpProtocolAdapter` if the protocol is served
over HTTP). You get exactly one thing to work with: a
`ProtocolAdapterContext` — the pipeline, the resource registry, an event sink, a
logger, a clock, an id generator and the public base URL.

```ts
import type {
  HttpProtocolAdapter,
  ProtocolAdapterContext,
} from '@devlab.group/agent-commerce';
import {
  PAYMENT_INPUT_FIELD,
  toErrorEnvelope,
  toPaymentRequiredEnvelope,
  toCommerceError,
} from '@devlab.group/agent-commerce';

export function createExampleAdapter: HttpProtocolAdapter {
  let ctx: ProtocolAdapterContext | undefined;

  return {
    name: 'example',
    mountPath: '/example',
    descriptor: {
      name: 'example',
      kind: 'protocol',
      implementationVersion: '1.0.0',
      supportedSpec: 'example-spec@2026-01-01', // pin it, do not hand-wave
      capabilities: ['discovery', 'invoke'],
      unsupported: ['subscriptions', 'batch'], // be explicit
      status: 'experimental',
    },

    async start(context) {
      ctx = context;
      // register the resources this protocol exposes
      for (const resource of context.resources.listExposedVia('example')) {
        // map resource.inputSchema into your protocol's schema language
      }
    },

    async handleHttp(req, res) {
      if (!ctx) throw new Error('adapter not started');
      const requestId = ctx.ids.next('req');
      try {
        const outcome = await ctx.pipeline.execute({
          requestId,
          resourceId: /* from the wire */ '',
          input: /* from the wire, with the payment field removed */ {},
          protocol: 'example',
          receivedAt: ctx.clock.nowIso,
          // payment: { method: 'x402', payload } when a proof was supplied
        });

        if (outcome.kind === 'payment-required') {
          // ALWAYS use the shared envelope — do not invent your own shape
          respond(res, 402, toPaymentRequiredEnvelope(outcome));
          return;
        }
        respond(res, 200, outcome.body);
      } catch (error) {
        const commerceError = toCommerceError(error);
        respond(res, commerceError.httpStatus, toErrorEnvelope(commerceError));
      }
    },

    async health {
      return { status: ctx ? 'pass': 'fail', checkedAt: new Date.toISOString };
    },

    async stop {
      ctx = undefined;
    },
  };
}
```

### Rules

- **Never call a merchant backend.** Everything goes through
  `pipeline.execute`. An adapter that fetches a backend directly bypasses
  payment enforcement, and that is the one bug this architecture exists to make
  impossible.
- **Never implement payment logic.** You surface `PaymentRequiredOutcome`; you
  do not decide what is owed or whether a proof is valid.
- **Never redeclare a canonical type.** Import it.
- **Map errors deterministically.** `toErrorEnvelope(toCommerceError(e))`. No
  stack traces, no internal messages on the wire.
- **Fail in isolation.** A throw inside your adapter must not take down the
  process or another adapter.
- **Be honest in `descriptor`.** `supportedSpec` is a pinned revision;
  `unsupported` is a real list; `status` is `experimental` until conformance
  tests say otherwise.

### Checklist before review

- [ ] schema mapping from `CommerceResource`
- [ ] request normalisation into `CanonicalRequest`, `_payment` stripped from input
- [ ] `PaymentRequiredEnvelope` and `ErrorEnvelope` used verbatim
- [ ] honest `AdapterDescriptor`
- [ ] conformance fixtures pinning the spec revision
- [ ] contract tests driven through a **real client** of the protocol, not just
      the adapter's internal functions
- [ ] `docs/protocols.md` row and a support-matrix update
- [ ] no new dependency in `src/core`

## A payment provider

Implement `PaymentProvider`: `createRequirement`, `verify`, `settle`, `health`.

```ts
export function createExampleProvider(options: ExampleOptions): PaymentProvider {
  return {
    name: 'example-rail',
    descriptor: { /* honest */ },

    async createRequirement(context) {
      return {
        id: /* … */,
        requestId: context.requestId,
        resourceId: context.resource.id,
        provider: 'example-rail',
        amount: context.amount, // decimal display units, unchanged
        currency: context.currency,
        destination: options.payTo, // merchant-controlled
        challenge: {
          provider: 'example-rail',
          version: '1',
          accepts: [/* your rail's native requirement object, opaque to core */],
        },
      };
    },

    async verify(context) {
      // No side effects that move money. Ever.
      // Return { status: 'rejected', rejectionReason } instead of throwing
      // for an invalid proof; throw PAYMENT_PROVIDER_UNAVAILABLE only when the
      // rail itself is unreachable.
      // MUST return a replayKey derived ONLY from the authorisation.
    },

    async settle(context) {
      // Runs only after verify succeeded AND the replay key was reserved.
    },

    async health { /* fast, never throws */ },
  };
}
```

### Rules

- `verify` must not move funds. `settle` is the only place that does.
- `replayKey` must be derived **only** from the payment authorisation, never
  from the request id — otherwise a replay against a different request slips
  through.
- Distinguish *rejected* (the payment is bad — not retryable) from
  *unavailable* (the rail is down — retryable). The pipeline treats them
  differently and so do clients.
- The gateway must never need a merchant or buyer private key to use your rail.
  If it does, the design is wrong for this project.
- Amounts arrive as decimal strings in display units. Do the base-unit
  conversion yourself, deterministically, without floating point.

### Checklist before review

- [ ] negative tests: no payment, malformed, wrong amount, wrong recipient,
      wrong network, wrong asset, replay, expired, provider unavailable
- [ ] a deterministic settlement proof — a real state change, not a mocked
      success
- [ ] no key material held by the gateway
- [ ] honest `descriptor` with a real `unsupported` list
- [ ] `docs/protocols.md` and `docs/payment-flow.md` updated
