# HTTP surface

| Route                                              | Purpose                                                    |
| -------------------------------------------------- | ---------------------------------------------------------- |
| `GET /health`                                      | liveness                                                   |
| `GET /ready`                                       | readiness for the store, adapters and configured providers |
| `GET /.well-known/agent-commerce`                  | merchant, protocol and provider discovery                  |
| `GET /api/resources`                               | canonical resource list                                    |
| `POST /api/resources/:id/invoke`                   | invoke; returns 402 when proof is absent                   |
| `GET /api/receipts`, `GET /api/events`             | operator audit                                             |
| `GET /api/payment-attempts`                        | operator payment ledger; `?uncertain=true` for reconciliation |
| `/mcp`                                             | MCP Streamable HTTP when enabled                           |
| `/.well-known/agent-card.json`, `/a2a`             | A2A discovery and JSON-RPC when enabled                    |
| `/.well-known/acp.json`, `/acp/checkout_sessions…` | ACP discovery and checkout when enabled                    |

The invoke route uses the selected rail's headers:

| Rail | Proof                        | Challenge on 402                | Refused proof or spent authorization (402) | Refused settlement (402)                                                | Delivered response                       | Backend error after settlement |
| ---- | ---------------------------- | ------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------- | ------------------------------ |
| x402 | `PAYMENT-SIGNATURE`          | `PAYMENT-REQUIRED`              | a fresh `PAYMENT-REQUIRED` with `error`    | `PAYMENT-RESPONSE` with `success: false`                                | `PAYMENT-RESPONSE`                       | `PAYMENT-RESPONSE`             |
| MPP  | `Authorization: Payment ...` | `WWW-Authenticate: Payment ...` | a fresh `WWW-Authenticate`                 | a fresh `WWW-Authenticate` and `PAYMENT-RESPONSE` with `success: false` | `Payment-Receipt` and `PAYMENT-RESPONSE` | `PAYMENT-RESPONSE`             |

The error body carries `details.challenge` when the pipeline supplies a
retry challenge. Other outcomes:

- A replay returns 409 without a challenge if the first attempt is unfinished,
  has the legacy `failed` status, or its status is unavailable. Issuing another
  challenge could lead to a second payment for the same request.
- Replay `details.network` identifies the paid offer's network. A fresh x402
  challenge on 402 uses that family's replay `error`:
  `invalid_exact_evm_nonce_already_used` on EVM,
  `invalid_exact_near_payload_delegate_action_nonce_already_used` on NEAR, and
  `duplicate_settlement` on Solana, whose SDK has no replay code of its own.
- A missing Permit2 token allowance (`permit2_allowance_required`) returns
  412 Precondition Failed with a fresh `PAYMENT-REQUIRED`, per the `exact`
  EVM scheme. The buyer approves Permit2 and retries.
  `x402HTTPClient.parsePaymentResult` decodes that header only on 402;
  for 412, call `getPaymentRequiredResponse` or read `details.challenge`
  in the response body.
- A settlement without a verdict returns 502 with `PAYMENT-RESPONSE`. Its
  reason is `settlement_pending` when a transaction hash is available, or
  `unexpected_settle_error` otherwise.
- A settled `PAYMENT-RESPONSE` includes `amount` in base units when the
  provider supplies it. Paid deliveries use `Cache-Control: private`; fresh
  402 challenges use `no-store`.
