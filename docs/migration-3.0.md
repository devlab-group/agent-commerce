# Upgrading from 2.x to 3.0

This guide describes the planned 3.0.0 migration: removing forms deprecated in
2.x, making optional fields required and changing defaults. Review these
changes before upgrading.

## Transactions

The 2.5.0 API adds optional transaction IDs to purchase records and optional
journal methods to `ReceiptStore`. The 3.0.0 plan changes these contracts:

- `transactionId` will be required on `CommerceEvent`, `CommerceReceipt`,
  `PaymentAttempt`, `DeliveredOutcome` and `PaymentRequiredOutcome`. For rows
  written before 2.5.0, the built-in store is planned to supply
  `legacy_<requestId>` when reading, without rewriting its tables.
- The `ReceiptStore` journal methods will be required: `recordTransactionStep`,
  `getTransaction`, `listTransactions`, `getPaymentAttempt` and
  `resolvePaymentAttempt`. Custom stores must implement them.
- `DeliverySummary.receiptId` will become optional. Under the 2.5.0 contract,
  a failed receipt write keeps the ID with `receiptCommitted: false`; 3.0.0
  will omit the ID. If your client requires `receiptId`, update it to handle a
  summary without one.

## Store methods added in 2.6.0

The optional `ReceiptStore` methods added in 2.6.0 are planned to become
required in 3.0.0. Custom stores will need to implement:

- Idempotency claims: `claimIdempotencyKey`, `updateIdempotencyKey` and
  `recoverIdempotencyKeys`.
- Authorization holds: `reserveAuthorizationHold`,
  `transitionAuthorizationHold`, `getAuthorizationHoldState` and
  `listOrphanAuthorizationHolds`.
- Pending tasks: `putPendingTask`, `getPendingTask` and `takePendingTask`.
- Payment attempts: `findPaymentAttemptByReplayKey`.

The 3.0.0 plan also requires `getIdempotencyKey`, added in 2.7.0. Custom stores
implementing it should follow these 2.7.0 rules, checked by the
`@devlab.group/agent-commerce/testing` conformance cases:

- `claimIdempotencyKey` takes an optional `owner` tag, which both it and
  `getIdempotencyKey` return on `in-flight` and `unresolved` results. A store
  that omits it forces verification of every proof before the gateway refuses
  an unfinished payment key.

The 3.0.0 plan removes these store settings deprecated in 2.6.0:

- `authorization.ap2.replay.path` and `protocols.acp.idempotency.path`.
  Import these files by starting 2.6.x with the keys still set, then remove
  each key after its import succeeds. The 3.0.0 plan includes no import for
  these files. See
  [Deprecated store files](storage.md#deprecated-store-files).
- `Ap2AuthorizationProviderOptions.replayStore` and
  `AcpAdapterOptions.idempotency.path`. Pass `store` with a `ReceiptStore`
  that implements the authorization-hold or idempotency methods.

## Envelopes

2.1.0 deprecated `destination`, `network` and `asset` in
`PaymentRequiredEnvelope.payment`; 3.0.0 will remove them. This envelope is
the HTTP 402 body, MCP `structuredContent` and the A2A task's data part, so the
change affects both TypeScript consumers and wire clients.

Read the corresponding fields from each offer in `accepts`:

| Deprecated field | x402 offer | MPP challenge                   |
| ---------------- | ---------- | ------------------------------- |
| `destination`    | `payTo`    | `request.recipient`             |
| `network`        | `network`  | `request.methodDetails.chainId` |
| `asset`          | `asset`    | `request.currency`              |

MPP's `chainId` is a number; the deprecated `network` uses the string
`eip155:<chainId>`. Multi-offer x402 challenges already omit all three
deprecated fields in 2.x.
