# Security Policy

> **Alpha warning.** `v0.1.0-alpha` is experimental software. Do not use it with
> production funds without an independent security review.

## Non-custodial by design

Agent Commerce Gateway is **not** a payment processor, wallet, exchange or
custodian.

- The gateway **never** accepts, stores, derives or requires a merchant or buyer
  production private key or seed phrase.
- The merchant settlement destination is plain configuration
  (`payments.x402.payTo: ${MERCHANT_WALLET}`) — an address the merchant
  controls. It is never a gateway-owned wallet.
- Funds move **buyer → merchant destination** through the payment protocol
  itself. With x402 `exact`/EVM this is an EIP-3009 `transferWithAuthorization`:
  the buyer signs an authorisation that names the merchant as recipient, so a
  facilitator that broadcasts it cannot redirect the money.
- Rationale and detail:.

## Private-key policy

- **No real private key is ever committed to this repository.**
- The only keys present are Anvil's well-known deterministic development
  accounts, used exclusively on the local demo chain. Every occurrence is
  labelled `LOCAL DEVELOPMENT ONLY - DO NOT FUND`. Anyone can spend from them;
  they are public knowledge. Never send real assets to those addresses.
- The buyer key used by the demo is **Anvil well-known account #2**, defined in
  `src/payments/x402/local-chain/accounts.ts` (`LOCAL_BUYER_ACCOUNT`) and
  written into `.deploy/local.json` by `npm run chain:deploy`; the demo agent
  reads it from that manifest. It is never read by the gateway and the gateway
  never signs with it. Key locations in this document are stated literally: if
  one moves, this bullet is wrong until it is updated.
- The local facilitator signer pays gas on the dev chain only. Production
  deployments point at an external facilitator instead.

## What the gateway protects

- **Fail-closed paid resources.** A paid resource is delivered only after a
  successful `verify`, a successful replay reservation, and a successful
  `settle`. Missing, malformed, expired, replayed, wrong-amount,
  wrong-recipient, wrong-network and wrong-asset payments all fail closed, and
  each has a test.
- **Replay defence at the gateway, not only on-chain.** EIP-3009's
  `authorizationState` prevents a double *spend*, but a replayed authorisation
  could otherwise unlock a second delivery before the first settles. The payment
  provider derives a `replayKey` from the authorisation (payer, nonce, asset,
  network) and the pipeline reserves it under a `UNIQUE` constraint *before*
  settling. A duplicate is `PAYMENT_REPLAYED`.
- **Bounded backend calls.** Every merchant backend call has an explicit
  timeout *and* a 1 MB cap on the response body — a timeout bounds a call by
  time, not by bytes. There is no unbounded outbound HTTP request.
- **Host-header (DNS-rebinding) validation.** Every request, browser or not, is
  checked against the configured host allow-list before routing. A rebinding
  attacker's page reaches the gateway with its *own* hostname in `Host`, never
  a configured one, so the request is refused before it can drive the operator
  routes from inside the victim's network. See `src/gateway/access-control.ts`.
- **Configuration validated before startup.** Invalid configuration fails the
  process rather than starting a half-configured gateway.
- **Secret redaction.** The logger redacts `authorization` headers, the
  `x-payment` header, and `privateKey`, `signerPrivateKey`, `signature`,
  `seed`, `mnemonic`, `secret`, `apiKey`, `adminToken` and `token` fields **at
  the top level and one level deep** — pino's redaction wildcards are
  single-level, so a secret nested at depth two or more is not covered by the
  logger and must not be handed to it (every call site funnels caught errors
  through `describeError`, which extracts only `{message, name}`). Receipts
  and events persist
  no secrets and no raw payment proofs.
- **Input validation** on resource inputs, path parameters, body size, content
  type, payment metadata and configuration.

## Which routes are authenticated

**None of the agent-facing routes, by design.** An agent that can pay is a
customer, not an intruder, so `POST /api/resources/:id/invoke`, `/mcp`,
`GET /api/resources`, `GET /health` and `GET /.well-known/agent-commerce` are
open. Paid resources are protected by payment, not by authentication.

**The operator routes are different.** `GET /api/receipts`, `GET /api/events`
and `GET /api/events/stream` expose the merchant's commerce ledger — payer and
payee addresses, amounts, settlement transaction hashes, resource ids and
timings. That is revenue history and customer on-chain identity, not public
data. They require `server.adminToken`, and **if no token is configured they
return 404 rather than serving openly**.

The dashboard needs this same token to read those routes, via
`VITE_ADMIN_TOKEN` — and because Vite inlines every `VITE_`-prefixed variable
into the JavaScript it serves, that token is **not a server-side secret once it
reaches the dashboard**. It is a public value, readable by anyone who can load
the dashboard's page, not merely anyone who can reach the gateway. The demo
stack accepts this because the dashboard is loopback-only and ships a
non-secret placeholder; a real deployment must not point a real
`server.adminToken` at this variable. The dashboard's port is a different trust
boundary from the gateway's, and there is currently no server-side proxy that
would keep the token off the client (post-alpha).

Browser access is governed by `server.allowedOrigins`, an explicit allowlist
that defaults to empty. Agent traffic is not browser traffic and receives no
CORS headers at all.

### The live event stream is polled, not streamed, when a token is configured

A browser `EventSource` cannot send custom headers, so the dashboard's SSE
connection to `/api/events/stream` cannot carry the admin token. It therefore
receives a 401 when a token is configured — and a 404 when one is not, because
the operator routes are closed by default. **There is no posture in which a
browser can read the stream.** The route remains usable by a header-capable
client; the dashboard uses authenticated polling of `GET /api/events`, which is
its intended path rather than a degraded mode.

Accepting the token as a `?adminToken=` query parameter on that one route would
keep the stream working in a browser. **It is deliberately not supported.** The
cost — credentials leaking through `Referer`, browser history and intermediary
logs — buys a convenience nothing needs, because the dashboard polls instead.
Do not add it without a client that genuinely requires it and a reason that
outweighs putting a credential in a URL.

## What the gateway does **not** protect against

Be clear-eyed about this. Running this gateway does not make your agent, your
backend or your business secure.

- **It does not secure your merchant backend.** Authentication, authorisation,
  rate limiting and data protection in your API remain entirely your
  responsibility.
- **It does not vet the buyer.** Any party able to produce a valid payment gets
  the resource. There is no KYC, sanctions screening, fraud scoring or dispute
  mechanism.
- **It does not make payments reversible.** On-chain settlement is final. There
  are no refunds, chargebacks or escrow in v0.1.
- **It does not protect against SSRF beyond configuration discipline.** The
  gateway calls the backend URLs an administrator configured. Redirects are not
  followed. But if you configure an internal URL, the gateway will call it —
  agent- or user-controlled backend URLs are forbidden, and there is no
  allowlist enforcement in v0.1.
- **It does not audit the payment protocol or its SDKs.** x402, the MCP SDK and
  their transitive dependencies are third-party code.
- **It does not provide multi-tenancy, RBAC or policy controls.**
- **It does not defend against a compromised host.** SQLite receipts and process
  memory are as safe as the machine the gateway runs on.
- **It does not guarantee delivery after settlement.** A backend failure after a
  successful payment is possible; it is recorded as an event and a payment
  attempt, and reconciliation is the merchant's responsibility.
- **It cannot always tell you whether a payment settled.** If the settlement
  transaction is broadcast but its receipt cannot be confirmed — an RPC timeout
  or a dropped connection — the outcome is genuinely unknown. The gateway
  records the attempt as `settlement-uncertain` with the broadcast transaction
  hash, and does **not** deliver the resource. Resolving it is the merchant's
  responsibility: check the recorded hash with `getTransactionReceipt`. The
  gateway will not report this as a failure, because it does not know that it
  was one.
- **It prioritises delivery over bookkeeping.** If a resource is delivered but
  persisting the receipt fails, the delivery still happens and the failure is
  logged. A missing receipt therefore does not prove a resource was not
  delivered.
- **A reserved payment authorisation is never released.** If settlement fails,
  that authorisation cannot be reused at this gateway even when nothing moved
  on-chain. This is deliberate — releasing it would reopen a replay window —
  but a buyer hit by a transient error must sign a fresh authorisation.
- **A rejected request can still have been charged for.** A few request-shape
  errors are only detectable when the backend call is assembled, which happens
  after settlement. The gateway hoists the checks it can — empty, `.` and `..`
  path parameters, and input keys colliding with an operator-configured query
  parameter, are all rejected **before** any payment is taken. But settlement is
  final and there are no refunds, so if you configure a resource whose inputs can
  fail late, your buyers can pay for a request that is never delivered. The
  attempt is recorded as `settled` with a `backend.failed` event sharing the same
  `requestId`, so reconciliation is possible.
- **It does not rate limit anything.** Free resources are an unauthenticated
  proxy to your backend at whatever rate a caller chooses. Rate limiting,
  quotas and abuse controls belong in your API or your edge.
- **The alpha has not had an independent security audit.**

## Supported versions

| Version       | Supported                      |
| ------------- | ------------------------------ |
| `0.1.x-alpha` | Latest alpha only, best effort |

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

1. Use GitHub's **Report a vulnerability** (Security → Advisories) on this
   repository: <https://github.com/devlab-group/agent-commerce/security/advisories/new>.
   That is the only private reporting channel — this project publishes no
   maintainer email address, and an earlier revision of this page pointed at a
   list in `CONTRIBUTING.md` that does not exist.
2. Include: affected version/commit, a description, reproduction steps, and the
   impact you believe it has.
3. You will get an acknowledgement within **5 working days** and a status update
   at least every **10 working days** until resolution.
4. Please give us **90 days** before public disclosure, or less by agreement if
   a fix ships sooner.

We will credit reporters in the release notes unless you prefer otherwise.

## Out of scope for reports

- The deliberately public Anvil development keys and the local demo chain.
- The demo merchant API's failure-injection routes (`/api/slow`, `/api/fail`),
  which exist only to test the gateway.
- Missing hardening we already document as out of scope above.
