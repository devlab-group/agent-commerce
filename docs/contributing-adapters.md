# Writing adapters and payment providers

Protocol adapters and payment providers translate external protocols into the
canonical contracts in `src/core`; they must not copy protocol-specific types
into core.

`ProtocolName` and `PaymentMethodName` are closed frozen-contract unions. A new
implementation for an existing name needs no core change. A new protocol or
rail name requires approval and a contract update before implementation; see
[contracts.md](contracts.md).

## Registering a new protocol or rail name

A new name crosses the public contract and runtime wiring. After approval and
an ADR:

1. Update `ProtocolName` and `PROTOCOL_NAMES`, or `PaymentMethodName` and
   `PAYMENT_METHOD_NAMES`, in `src/core/domain/common.ts`.
2. Add its strict config block and normalization in `src/config/schema.ts`.
3. Wire a protocol adapter in `src/gateway/main.ts`, or build a payment rail in
   `src/gateway/payment-providers.ts`.
4. For a rail, add its incoming proof and payment-challenge branches in
   `src/gateway/routes.ts`; add a receipt branch only if the rail defines one.
   The route already sends `Cache-Control: no-store` on every challenge and
   `PAYMENT-RESPONSE` after settlement. MCP and A2A use rail-independent proof
   and result envelopes. Update `src/protocols/mcp/tool-mapping.ts` if the new
   rail needs distinct proof instructions in tool discovery.
5. If it has distinct optional dependencies, add the narrow subpath, build
   entry, package export, optional peer and the real-package check in
   `tests/unit/cli/packaging.test.ts`.
6. Add its descriptor, discovery and `doctor` output. Update the frozen
   contract, conformance coverage, and a dedicated section in
   [protocols.md](protocols.md).

## Protocol adapters

Implement `ProtocolAdapter`, or `HttpProtocolAdapter` for an HTTP-mounted
protocol. `start()` receives a `ProtocolAdapterContext` containing the pipeline,
resource registry, event sink, logger, clock, id generator and public base URL.

For adapters whose protocol payload carries invocation input as an object, such
as MCP and A2A, the core flow is:

```ts
try {
  const requestId = context.ids.next(protocol);
  const resource = context.resources.get(resourceId);
  const { input, payment, authorization } = extractReservedInputFields(
    rawInput,
    resource,
    requestId,
  );
  const outcome = await context.pipeline.execute({
    requestId,
    resourceId,       // parsed from the protocol request
    input,            // reserved proof fields removed
    protocol,
    receivedAt: context.clock.nowIso(),
    ...(payment ? { payment } : {}),
    ...(authorization ? { authorization } : {}),
  });

  return mapProtocolOutcome(outcome);
} catch (error) {
  return mapProtocolError(toCommerceError(error));
}
```

The adapter owns wire parsing and response mapping. Its preliminary resource
lookup supports carrier parsing and protocol exposure checks; the pipeline
resolves the resource again for execution. MCP and A2A embed canonical
payment-required and error envelopes in their protocol results, while ACP maps
them to ACP bodies. The canonical HTTP invoke route uses headers and lives in
`src/gateway/routes.ts`; an `HttpProtocolAdapter` instead owns a protocol-specific
raw HTTP mount. The pipeline owns authoritative resource lookup, input
validation, authorization, payment, backend execution and receipts.

### Adapter rules

- Send every invocation through `pipeline.execute()`; never call a merchant
  backend directly.
- Surface `PaymentRequiredOutcome`; do not calculate prices or verify proofs.
- Import canonical types instead of redeclaring them.
- Use `toPaymentRequiredEnvelope()` and
  `toErrorEnvelope(toCommerceError(error))` where the wire contract permits.
  Protocols such as ACP map canonical outcomes and errors into their own
  response bodies. Never expose stack traces or internal errors.
- For input-object protocols, call
  `extractReservedInputFields(rawInput, resource, requestId)`. It removes and
  parses `_payment` and `_authorization`, and labels a payment proof with the
  resource's first payment method. The canonical HTTP invoke route parses both
  carriers from headers.
- Keep handler failures inside the adapter and report health through
  `health()`.
- Pin `descriptor.supportedSpec`, list real `capabilities` and `unsupported`
  features, and keep `status: experimental` until conformance coverage supports
  promotion.

### Adapter review checklist

- [ ] map `CommerceResource` schemas into the protocol's discovery format
- [ ] normalize requests into `CanonicalRequest`
- [ ] use the shared envelopes where the wire contract permits; otherwise test
      the protocol-specific mapping
- [ ] publish an accurate `AdapterDescriptor`
- [ ] pin the specification revision in fixtures
- [ ] run contract tests through a real protocol client, not only adapter
      internals
- [ ] update the support matrix in [protocols.md](protocols.md)
- [ ] keep protocol-specific dependencies and types out of `src/core`

## Payment providers

Implement `PaymentProvider`: `createRequirement`, `verify`, `settle` and
`health`. The sketch below is partial; each rail defines the contents of its
challenge envelope.

```ts
const provider: PaymentProvider = {
  name,
  descriptor,

  async createRequirement(context) {
    return {
      id: ids.next('payment'),
      requestId: context.requestId,
      resourceId: context.resource.id,
      provider: name,
      amount: context.amount,
      currency: context.currency,
      destination: options.destination, // merchant-controlled
      challenge: { provider: name, version, accepts, envelope },
    };
  },

  async verify(context) {
    // Validate only. Return rejected for a bad proof and include a replayKey
    // derived only from the authorization when verification succeeds.
  },

  async settle(context) {
    // The pipeline calls this after verification and replay reservation.
  },

  async health() {
    return { status: 'pass', checkedAt: clock.nowIso() };
  },
};
```

### Provider rules

- `verify` must not move funds; settlement belongs in `settle`.
- Derive `replayKey` only from the payment authorization, never from the
  request id. The same authorization must collide across requests.
- Return `rejected` for an invalid proof. If the provider cannot reach a
  verdict, throw a `CommerceError` with code `PAYMENT_PROVIDER_UNAVAILABLE` so
  clients can distinguish a bad payment from an outage. An untyped throw from
  `verify` becomes `PAYMENT_INVALID`.
- Accept decimal display-unit strings and convert to base units without
  floating point.
- Set `destination` from merchant configuration. It must never be a
  gateway-owned wallet.
- Never require a buyer or merchant production private key. If the rail uses a
  facilitator key, keep that role separate from buyer and merchant custody.
- Keep `health()` fast. Its `detail` is optional and may be dynamic; the
  framework does not sanitize it, so treat it as operator-visible and avoid
  secrets. Prefer a failed health result to throwing.

### Provider review checklist

- [ ] negative tests cover missing, malformed, expired, replayed, wrong-amount,
      wrong-recipient, wrong-network and wrong-asset proofs, plus provider
      unavailability and backend failure after successful settlement
- [ ] settlement tests prove a real deterministic state change, not a mocked
      success
- [ ] no buyer or merchant production key is held by the gateway
- [ ] the descriptor lists supported and unsupported behavior accurately
- [ ] [protocols.md](protocols.md) and [payment-flow.md](payment-flow.md) are
      updated
