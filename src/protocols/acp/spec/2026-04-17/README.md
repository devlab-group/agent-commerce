# Vendored ACP schema - snapshot `2026-04-17`

`schema.agentic_checkout.json` copies the ACP checkout schema from the
upstream commit below. The adapter validates against this local snapshot, so a
schema change requires a reviewed code change.

| | |
|---|---|
| ACP version | `2026-04-17` (stable snapshot) |
| Upstream repository | https://github.com/agentic-commerce-protocol/agentic-commerce-protocol |
| Upstream path | `spec/2026-04-17/json-schema/schema.agentic_checkout.json` |
| Upstream commit | `6b828681206f1f98a3faba978610ced66770d2ae` (2026-05-01) |
| Date vendored | 2026-09-07 |
| License | Apache-2.0, (c) the ACP contributors - see the upstream `LICENSE` and `NOTICE` |

The file is excluded from Biome in `biome.json`: a formatter pass would rewrite
it and the copy would no longer be verifiable against upstream.

## Amended after release

Upstream amended the dated snapshot after release. The release commit
`9abf303` (2026-04-17) contains schema blob `93a88203`. Commit `6b82868`
("SEP: Order Schema - Post-Checkout Alignment") changed `Order`,
`OrderLineItem`, `OrderLineItemQuantity`, `Fulfillment`, `FulfillmentEvent` and
`Adjustment`. This repository vendors the later blob, `9c019241`. For example,
an order with `quantity: { ordered, shipped }` but no `current` may satisfy the
release-day schema but fails validation here.

## Updating

Do not track `main`, do not import `spec/unreleased`, and do not update this
file on its own. A new snapshot means a new directory beside this one, a new
`ACP_SPEC_VERSION`, and a deliberate decision about which versions
`API-Version` still accepts - the adapter advertises exactly the snapshots it
was tested against.

The matching official examples are vendored under
`tests/fixtures/acp/2026-04-17/` from the same commit, and the validators are
tested against them. `tests/conformance/acp/snapshot.test.ts` pins both files
to their upstream git blob hashes, so a local edit to either fails the suite.
