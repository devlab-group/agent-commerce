# Troubleshooting

`validate` and `start` print typed failures as `FAIL  CODE: message`; other
failures use `FAIL  message`. JSON details may name the config key in `path`.
Fix the reported problem, then rerun the command that reported it, such as
`npx --no -- agent-commerce validate --env-file .env`. `validate` does not
load optional peers, so only `start` reports a missing package.

## `CONFIG_INVALID`

| Message contains                                                                              | Fix                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Unresolved environment variable "${NAME}"`                                                   | Ask the user to set `NAME` in `.env`, then pass `--env-file .env`                                                                                                                                             |
| `Configuration invalid at "<path>"`                                                           | A missing, misspelled or unknown key at `<path>`, or a `${VAR}` there set to an empty value; compare with `references/config.md`                                                                              |
| `is exposed via "mcp" but protocols.mcp.enabled is false`                                     | Enable the protocol, or remove it from that resource's `expose`                                                                                                                                               |
| `none of which is configured and enabled under "payments"`                                    | Enable the rail under `payments`, or make the resource free                                                                                                                                                   |
| `is priced in ..., but x402 settles in ...`                                                   | Price it in the currency the message names                                                                                                                                                                    |
| `is a well-known Anvil development address`                                                   | `payTo` must be the user's own wallet                                                                                                                                                                         |
| `allowMainnet`, `allowUnauthenticatedFacilitator`, `plain HTTP`, `must be reached over https` | A mainnet opt-in, or a facilitator URL that is not `https` (plain `http` works only for a local or private host off mainnet); see `references/production.md`. Do not add an opt-in without the user's consent |
| `is enabled, but the package "<package>" is not installed`                                    | Install every peer SKILL.md step 5 lists for that feature, at the versions `npx --no -- agent-commerce version` prints, then rerun `start`                                                                    |
| `Could not read configuration file`                                                           | Pass `--config <path>`, or run from the directory holding `config.yaml`                                                                                                                                       |

## Startup

- An unreadable `--env-file` stops the command. Node 24.8.0 rejects a missing
  file before the CLI runs, with exit 9 and a `not found` error. Create `.env`
  from `.env.example` and fill it locally, or pass the correct path.
- `FAIL  listen EADDRINUSE`: another process holds
  `server.port`. Pick another port or stop that process.
- `STORAGE_ERROR`: the receipts file (`storage.receipts.path`) cannot be
  opened or written. Fix the path or its permissions.

## HTTP responses

| Status and code                       | Meaning                                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 402 `PAYMENT_REQUIRED`                | Expected for an unpaid call to a paid resource                                                                                   |
| 402 `PAYMENT_INVALID`                 | The payment proof failed verification; the response includes a fresh challenge when the rail provides one                        |
| 409 `PAYMENT_REPLAYED`                | That proof is already in use, or its settlement outcome is unknown. Do not pay again; check receipts first                       |
| 400 `INPUT_INVALID`                   | The request body does not match the resource `input` schema                                                                      |
| 404 `RESOURCE_NOT_FOUND`              | Unknown resource id, or the resource does not list `http` in `expose`                                                            |
| 502 `BACKEND_ERROR`                   | The API was unreachable or answered outside 2xx; redirects are not followed. Check `MERCHANT_API_BASE_URL` and the API's logs    |
| 504 `BACKEND_TIMEOUT`                 | The API took longer than `backend.timeoutMs`                                                                                     |
| 503 `PAYMENT_PROVIDER_UNAVAILABLE`    | The facilitator or RPC is unreachable, or a lazily loaded peer is missing. The paid resource is not delivered                    |
| 402 `PAYMENT_SETTLEMENT_FAILED`       | The provider rejected settlement; the resource is withheld and a fresh challenge is included when available                      |
| 502 `PAYMENT_SETTLEMENT_FAILED`       | Settlement is uncertain. Reconcile the attempt before paying again; a missing transaction hash does not prove that nothing moved |
| 403 `FORBIDDEN`, `Host not allowed`   | The `Host` header is neither `merchant.publicBaseUrl`'s hostname nor a loopback name. Behind a proxy, keep the `Host` header     |
| 403 `FORBIDDEN`, `Origin not allowed` | A browser origin missing from `server.allowedOrigins`                                                                            |
| 404 on an operator route              | `server.adminToken` is not set; with it, send `Authorization: Bearer <token>`                                                    |

A replayed proof whose attempt already settled or was rejected gets a 402 with
a new challenge. Every other replay gets 409 without one, because a second
challenge could lead to a second payment.

A 502 `PAYMENT_SETTLEMENT_FAILED` means settlement was not confirmed and no
receipt was created. Use
`npx --no -- agent-commerce reconcile --env-file .env --dry-run` to report
chain evidence without recording resolutions or hold updates; omit `--dry-run`
to apply them. Retry `unknown` results later, or investigate on chain before
recording an operator verdict with `npx --no -- agent-commerce resolve`.

To inspect first, `GET /api/transactions?unresolved=true` lists unresolved
purchases. `GET /api/payment-attempts?uncertain=true` lists
`settlement-uncertain` and legacy `failed` attempts, with transaction IDs when
available. Both routes require the same operator token as `/api/receipts` and
`/api/events`.

If an upfront payment settled before the backend failed, the response is
502 `BACKEND_ERROR`, including for a backend timeout. It carries the settled
payment summary in the body and `PAYMENT-RESPONSE` header. Check the receipt
before retrying; the gateway does not refund the payment automatically.

## `doctor` checks

`doctor --json` returns `checks[]` with `name`, `status` (`PASS`, `WARN`,
`FAIL`, `INFO`) and `detail`, plus `exitCode`. Any `FAIL` makes the exit code 1;
otherwise it is 0, even with warnings. For L2, also require a passing `Gateway`
check and report warnings.

| Check                        | Not passing means                                                                                                                                                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Config`                     | `validate` would fail; fix that first                                                                                                                                                                                                                                                         |
| `Gateway`                    | `FAIL`: `/health` is unreachable or returns a non-2xx status. Check the URL derived from `server.host` and `server.port`, or pass `--gateway <url>`. `WARN`: `/health` passed but `/ready` did not; inspect `/ready` for store, adapter or provider failures                                  |
| `Backend`                    | No HTTP response from some or all distinct configured URLs. Probes use GET without backend headers or a body, substitute `demo-check` for path parameters and accept any HTTP status as reachable. Check the API and `MERCHANT_API_BASE_URL`; a PASS does not verify the configured operation |
| `Protocols`                  | The gateway's `/.well-known/agent-commerce` is unreachable                                                                                                                                                                                                                                    |
| `Payments`, `Payments (MPP)` | The running gateway's live offers or MPP setting differ from the config, usually because it runs an older config. Restart it                                                                                                                                                                  |
| `Payments (offers)`          | `FAIL`: an offer's health check fails; `WARN`: one is degraded. Causes include an unreachable RPC or facilitator, or a missing Solana, NEAR or CDP peer. Inspect `/ready`; the gateway logs each reason at debug level                                                                        |
| `Storage`                    | `WARN`: no receipts file at `storage.receipts.path` yet, or the running gateway uses another path. `FAIL`: the file cannot be opened                                                                                                                                                          |
