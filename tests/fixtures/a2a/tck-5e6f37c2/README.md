# Vendored A2A TCK schema - `a2a-tck@5e6f37c2`

`a2a.json` is the vendored response schema recorded below. The HTTP helpers in
`tests/conformance/a2a/tasks.test.ts` and
`tests/integration/a2a-x402-extension.test.ts` validate successful results
against it offline. Task and response-envelope definitions reject undeclared
properties; arbitrary JSON payloads remain open.

| | |
|---|---|
| Upstream repository | https://github.com/a2aproject/a2a-tck |
| Upstream path | `specification/a2a.json` |
| Upstream commit | `5e6f37c2d38eb3d7684686243c34d365c83df49b` (2026-11-18) |
| Git blob | `d6ea1ed438d788614b597f28009acfc8308aa8db` |
| A2A revision | v1.0.1, `3303592588e388e62e0f69f701af531d2f4e3991` (the TCK's `specification/version.json`) |
| Date vendored | 2026-11-22 |
| License | Apache-2.0, (c) the a2a-tck contributors - see the upstream `LICENSE` |

The schema's `$ref` values use filenames such as
`lf.a2a.v1.Task.jsonschema.json`. The local helper,
`tests/conformance/a2a/support/task-schema.ts`, maps these filenames to titled
definitions, such as `Task`, for offline validation. The upstream resolver is
`tck/validators/json_schema.py`.

`biome.json` excludes this directory to preserve the copied bytes.
`tests/conformance/a2a/task-schema.test.ts` checks the file's git blob hash.

## Updating

Copy the file from the chosen TCK commit into a new directory named after
that commit. Update the blob hash in the pin test and the schema path in
`task-schema.ts`. Prefer a TCK tag that vendors A2A v1.0.1.
