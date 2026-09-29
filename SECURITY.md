# Security Policy

> **No commissioned security audit.** The `v1.x` line commits to a stable
> public API and wire contract; it makes no assurance claim about the payment
> path. There is no third-party audit report to point you at, for any release.
> Weigh that before putting production funds through it.

## Reporting a vulnerability

Please report security issues **privately** - do not open a public issue.

1. Use GitHub's **Report a vulnerability** (Security → Advisories) on this
   repository: <https://github.com/devlab-group/agent-commerce/security/advisories/new>.
   That is the only private reporting channel; this project publishes no
   maintainer email address.
2. Include the affected version or commit, a description, reproduction steps,
   and the impact you believe it has.
3. You will get an acknowledgment within **5 working days**, and a status
   update at least every **10 working days** until it is resolved.
4. Please give us **90 days** before public disclosure, or less by agreement if
   a fix ships sooner.

We credit reporters in the release notes unless you would rather we did not.

### Out of scope for reports

- The deliberately public Anvil development keys and the local demo chain.
- Anything in [what the gateway does not protect against](#what-the-gateway-does-not-protect-against),
  which is documented rather than overlooked.

## Non-custodial by design

Agent Commerce Gateway is **not** a payment processor, wallet, exchange or
custodian.

- The payment flow does not require a merchant or buyer private key or seed
  phrase. Local facilitator mode does accept a configured gas-paying signer key;
  do not reuse a merchant or buyer key for it.
- The merchant settlement destination is plain configuration
  (`payments.x402.payTo: ${MERCHANT_WALLET}`), an address the merchant
  controls. It is never a gateway-owned wallet.
- Funds move **buyer → merchant destination** through the payment protocol
  itself. With x402 `exact`/EVM this is an EIP-3009 `transferWithAuthorization`:
  the buyer signs an authorization that names the merchant as recipient, so a
  facilitator that broadcasts it cannot redirect the money.
- The money path end to end: [`docs/payment-flow.md`](docs/payment-flow.md).

## Private-key policy

- **No real private key is ever committed to this repository.**
- The only keys present are Anvil's well-known deterministic development
  accounts, used exclusively on the local demo chain. Every occurrence is
  labeled `LOCAL DEVELOPMENT ONLY - DO NOT FUND`. Anyone can spend from them;
  they are public knowledge. Never send real assets to those addresses.
- The buyer key used by the demo is **Anvil well-known account #2**, defined in
  `src/payments/x402/local-chain/accounts.ts` (`LOCAL_BUYER_ACCOUNT`) and
  written into `.deploy/local.json` by `npm run chain:deploy`; the demo agent
  reads it from that manifest. The gateway never reads it and never signs with
  it. Key locations in this document are stated literally: if one moves, this
  bullet is wrong until someone updates it.
- Provider construction refuses a well-known Anvil signer when the RPC
  hostname does not look local or private. In local mode the health check also
  requires the RPC to answer `anvil_nodeInfo`, so `/ready` fails against any
  other node. Mainnet requires a remote facilitator.

## What the gateway protects

- **Fail-closed paid resources.** A paid resource is delivered only after a
  successful `verify`, a successful replay reservation, and a successful
  `settle`. Missing, malformed, expired, replayed, wrong-amount,
  wrong-recipient, wrong-network and wrong-asset payments all fail closed, and
  each has a test.
- **Replay defense at the gateway, not only on-chain.** EIP-3009's
  `authorizationState` prevents a double *spend*, but a replayed authorization
  could otherwise unlock a second delivery before the first settles. The payment
  provider derives a `replayKey` from the authorization (chain id, asset, payer,
  nonce) and the pipeline reserves it under a `UNIQUE` constraint *before*
  settling. A duplicate is `PAYMENT_REPLAYED`.
- **Purchase authorization, where a resource requires it.** With AP2 enabled, a
  paid resource can demand a signed Checkout Mandate proving the human behind
  the agent approved that exact purchase. It is verified and reserved before
  settlement, spendable once, and never a substitute for payment. Trust is
  static public keys in configuration, with no key discovery of any kind. See
  [`docs/ap2.md`](docs/ap2.md).
- **Bounded built-in HTTP calls.** The included HTTP backend executor applies
  a timeout and a 1 MiB response-body cap. Custom backend executors must
  enforce their own limits.
- **Host-header (DNS-rebinding) validation.** Every request, browser or not, is
  checked against the configured host allow-list before routing. A rebinding
  attacker's page reaches the gateway with its *own* hostname in `Host`, never
  a configured one, so the request is refused before it can drive the operator
  routes from inside the victim's network. See `src/gateway/access-control.ts`.
- **Configuration validated before startup.** Invalid configuration fails the
  process rather than starting a half-configured gateway.
- **Secret handling.** The default request log carries no request headers.
  The logger redacts credential and proof headers, and known secret fields
  **at the top level and one level deep** but not deeper. The receipt store
  redacts secret-shaped keys at any depth. The field list and what callers
  must keep out of logs and receipts are in
  [docs/security.md](docs/security.md#secret-handling).
- **Input validation** on resource inputs, path parameters, body size, content
  type, payment metadata and configuration.

## Which routes are authenticated

**Agent-facing routes are open by design.** `POST /api/resources/:id/invoke`,
`GET /api/resources`, `GET /health`, `GET /ready`,
`GET /.well-known/agent-commerce` and the `/mcp` and A2A mounts do not require
authentication. Paid resources require payment.

**ACP is the exception among agent routes.** When `protocols.acp` is enabled,
every checkout route under its mount requires
`Authorization: Bearer <protocols.acp.auth.token>`, compared in constant time;
ACP's own discovery document at `/.well-known/acp.json` stays public and
omits the bearer token, backend URLs and other private configuration. Request
`Signature` verification is not
implemented and a `Signature` header never substitutes for the bearer token, so
ACP must be deployed behind TLS. See [docs/security.md](docs/security.md#acp).

**The operator routes are different.** `GET /api/receipts` and
`GET /api/events` expose the merchant's commerce ledger: payer and payee
addresses, amounts, settlement transaction hashes, resource ids and timings.
That is revenue history and customer on-chain identity, not public data. They
require `server.adminToken`, and **if no token is configured they return 404
rather than serving openly**. The token is accepted only in the
`Authorization` header, never as a query parameter, which `Referer`, browser
history and intermediary logs could expose.

The dashboard needs that same token to read those routes, via
`VITE_ADMIN_TOKEN`. Because Vite inlines every `VITE_`-prefixed variable into
the JavaScript it serves, that token is **not a server-side secret once it
reaches the dashboard**: it is readable by anyone who can load the dashboard's
page, not merely by anyone who can reach the gateway. The demo stack accepts
this because the dashboard is loopback-only and ships a non-secret placeholder.
A real deployment must not point a real `server.adminToken` at this variable.
The dashboard's port is a different trust boundary from the gateway's, and
there is no server-side proxy that would keep the token off the client.

Browser access is governed by `server.allowedOrigins`, an explicit allowlist
that defaults to empty. Agent traffic is not browser traffic and receives no
CORS headers at all.

## What the gateway does **not** protect against

- **It does not secure your merchant backend.** Authentication, authorization,
  rate limiting and data protection in your API remain entirely yours.
- **It does not vet the buyer.** Any party able to produce a valid payment gets
  the resource. There is no KYC, sanctions screening, fraud scoring or dispute
  mechanism. An AP2 mandate proves a human approved the purchase; it says
  nothing about who that human is.
- **It does not make payments reversible.** On-chain settlement is final. There
  are no refunds, chargebacks or escrow.
- **It does not protect against SSRF beyond configuration discipline.** The
  gateway calls the backend URLs an administrator configured, and does not
  follow redirects. But if you configure an internal URL, the gateway will call
  it. Agent- or user-controlled backend URLs are forbidden, and there is no
  allowlist enforcement.
- **It does not audit the payment protocol or its SDKs.** x402, the MCP SDK and
  their transitive dependencies are third-party code.
- **It does not provide multi-tenancy, RBAC or policy controls.**
- **It does not defend against a compromised host.** SQLite receipts and process
  memory are as safe as the machine the gateway runs on.
- **It does not guarantee delivery after settlement.** A backend failure after a
  successful payment is possible; it is recorded as an event and a payment
  attempt, and reconciliation is the merchant's responsibility.
- **It cannot always tell you whether a payment settled.** A timeout or
  dropped connection during settlement can leave no verdict, even if a
  transaction was broadcast. The gateway records the attempt as
  `settlement-uncertain` and does **not** deliver the resource. When it has a
  transaction hash, the merchant can check it with `getTransactionReceipt`;
  without one, investigation starts from the request ID. The caller receives
  `PAYMENT_SETTLEMENT_FAILED`, which does not mean the funds stayed with the
  buyer.
- **It prioritizes delivery over bookkeeping.** If a resource is delivered but
  persisting the receipt fails, the delivery still happens and the failure is
  logged. A missing receipt therefore does not prove a resource was not
  delivered.
- **A reserved payment authorization is never released.** If settlement fails,
  that authorization cannot be reused at this gateway even when nothing moved
  on-chain. This is deliberate, since releasing it would reopen a replay
  window, but a buyer hit by a transient error must sign a fresh authorization.
  An AP2 mandate is handed back in the narrower case where settlement provably
  moved no money, and kept otherwise.
- **A rejected request can still have been charged for.** Most request-shape
  checks run **before** any payment is taken: missing, empty, `.` and `..` path
  parameters, a bound input group that is not an object, input keys that
  collide with an operator-configured query parameter, and illegal configured
  headers. Two checks run only when the backend call is made, after settlement:
  a URL that cannot be parsed, and path parameters that resolve outside the
  template's literal path prefix. Settlement is final and there are no
  refunds, so a buyer can pay for a request that is never delivered. The
  attempt is recorded as `settled` with a `backend.failed` event sharing the
  same `requestId`, so reconciliation is possible.
- **It does not rate limit anything.** Free resources are an unauthenticated
  proxy to your backend at whatever rate a caller chooses. Rate limiting,
  quotas and abuse controls belong in your API or your edge.
