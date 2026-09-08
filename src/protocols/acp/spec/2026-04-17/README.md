# Vendored ACP schema - snapshot `2026-04-17`

`schema.agentic_checkout.json` is a byte-for-byte copy of the released ACP
checkout schema. It is the wire contract this adapter validates against, and it
is vendored rather than fetched so a protocol upgrade is an explicit code change
with a diff, never something that happens at install or at runtime.

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

## Updating

Do not track `main`, do not import `spec/unreleased`, and do not update this
file on its own. A new snapshot means a new directory beside this one, a new
`ACP_SPEC_VERSION`, and a deliberate decision about which versions
`API-Version` still accepts - the adapter advertises exactly the snapshots it
was tested against.

The matching official examples are vendored under
`tests/fixtures/acp/2026-04-17/` from the same commit, and the validators are
tested against them.
