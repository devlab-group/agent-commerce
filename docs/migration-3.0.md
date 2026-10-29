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
