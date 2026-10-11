# Threat model: Agent Commerce Gateway

The full security notes are in the repository's `SECURITY.md` and `docs/security.md`. This file summarizes them for the scanner.

## What this project does and where untrusted input enters

Agent Commerce Gateway is a self-hosted TypeScript gateway that sits in front of a merchant's existing HTTP API and sells calls to it to AI agents. Agents reach it over plain HTTP (`/api/resources/:id/invoke`), MCP (`/mcp`), A2A (`/a2a`) and, when enabled, ACP checkout routes. Paid resources take x402 v2 `exact` payments (EVM with EIP-3009 or Permit2, Solana, and NEAR as partial support) or MPP payments, and can also require an AP2 Checkout Mandate. A resource can offer several networks or tokens; the gateway settles the offer the proof pays. Solana and NEAR settle only through a remote facilitator. The gateway never holds merchant or buyer funds: payments go from the buyer to the merchant's configured address.

- **Untrusted:** everything a caller sends.
  - HTTP, MCP JSON-RPC, A2A JSON-RPC and ACP request bodies.
  - Path parameters, query strings and resource inputs.
  - `Host` and `Origin` headers.
  - Payment proofs: x402 `PAYMENT-SIGNATURE`, MPP `Authorization: Payment …` credentials, the `_payment` field on MCP and A2A, and `x402.payment.payload` in A2A x402 extension messages. An x402 proof carries an EIP-3009 or Permit2 authorization, a partially signed Solana transaction or a signed NEAR delegate action, plus the offer the buyer says it accepted.
  - AP2 mandates (SD-JWT).
- **Semi-trusted:**
  - responses from the payment facilitator: verify and settle results, whose reason strings are sanitized, and `/supported`, which supplies the Solana fee payer;
  - the EVM, Solana and NEAR RPC nodes, read for health checks and by MPP's nonce check, and Anvil, which settles local payments;
  - responses from the merchant backend (the built-in executor enforces a timeout and a 1 MiB body cap).
- **Trusted:** the operator's configuration file and environment, including backend URLs, admin and ACP tokens, keys, facilitator settings and declared EVM networks, whose `kind` (testnet or mainnet) the operator asserts.

## Components that matter most / least

- **Most important:**
  - **The payment path:** `src/core` (request pipeline), `src/payments/x402` (offer selection, verification and settlement classification per chain family in `provider/`, replay keys in `replay-key.ts`), `src/payments/mpp`.
    - Select the offer the proof pays, verify, reserve the replay key, then settle before the response is released: before the backend call under `upfront` (MPP's default), after it under `authorization` (x402's default).
    - Every failure must fail closed. A settlement whose outcome is unknown withholds the response and keeps the replay key reserved (`settlement-uncertain`).
    - Delivery must happen at most once per payment authorization. Replay keys follow what each chain consumes: the EIP-3009 nonce, the Permit2 owner nonce, the Solana transaction message and the NEAR access-key nonce.
    - A facilitator or RPC failure must not be recorded as the buyer's refusal.
  - **AP2 verification:** `src/authorization/ap2`.
  - **Protocol adapters:** `src/protocols/mcp`, `src/protocols/a2a`, `src/protocols/acp`, `src/protocols/http.ts`.
  - **Access control and routing:** `src/gateway`.
    - Host-header (DNS-rebinding) validation in `access-control.ts`.
    - The admin token on `/api/receipts` and `/api/events`.
    - The ACP bearer token.
  - **Storage** (`src/storage`): receipts, events, payment attempts with their replay keys, and the history of attempts a retry reclaimed.
  - **Secret redaction** in logs and receipts.
- **Lower priority:**
  - `src/cli` (operator tooling);
  - `src/openapi` (imports an operator-supplied OpenAPI document);
  - `src/config`, which still matters because invalid configuration must fail startup.
- **Out of scope:**
  - `demo/`, `examples/`, `scripts/`, `contracts/` (local demo chain);
  - the deliberately public Anvil development keys;
  - the internals of third-party SDKs (`@x402/*`, `@solana/kit`, the MCP SDK, mppx). How the gateway uses them is in scope.

## How to exercise it

- `npm test` runs the unit, integration and conformance suites (Vitest). A few of them spawn Anvil, which this image installs.
- `npm run test:e2e` settles payments on Anvil, `solana-test-validator` and a NEAR sandbox. This image installs only Anvil, so the Solana and NEAR suites skip themselves.
- `tests/conformance/` drives the MCP, A2A and ACP adapters with the official client SDKs.
- `config-demo.yaml` describes a complete local setup. `npm run agent-commerce -- doctor --config config-demo.yaml` checks it.

## How we rate severity

- **Critical:**
  - a paid resource delivered without a successfully verified and settled payment;
  - a payment that settles to a recipient, amount, asset or network other than one of the resource's configured offers;
  - one payment authorization or AP2 mandate unlocking more than one delivery;
  - an AP2 requirement bypassed;
  - any path that discloses a private key.
- **High:**
  - unauthenticated access to the operator routes (`/api/receipts`, `/api/events`) or disclosure of `server.adminToken`;
  - an ACP bearer-token bypass;
  - a bypass of the Host-header validation;
  - credentials, payment proofs or tokens written to logs or receipts despite redaction;
  - code execution or path traversal reachable from untrusted input;
  - a buyer asked to pay again after a settlement that may have landed, such as an unknown outcome recorded as refused.
- **Medium:** denial of service from unauthenticated input that gets past the configured limits (body size, timeouts, batch handling, the 256-task A2A pending-payment store); disclosure of non-secret configuration.
- **Low:** findings that need a malicious or careless operator configuration; overly detailed error messages without secrets.

## Anything to leave alone

`SECURITY.md` → "What the gateway does not protect against" and the protocol pages under `docs/protocols/` list behavior that is documented and intended. Please do not report it:
- SSRF through backend URLs the operator configured;
- no buyer vetting or KYC;
- irreversible on-chain settlement;
- the documented divergence between payment and delivery in the `upfront` and `authorization` flows;
- an authorization staying reserved after a settlement whose outcome is unknown; only a rejected x402 attempt can be reserved again, and the chain still spends it once;
- NEAR network binding through the offer and the facilitator's RPC only, since the delegate signature names no chain;
- unpaid A2A extension tasks living in process memory, so a restart or another instance loses them;
- a compromised host;
- the demo dashboard's `VITE_ADMIN_TOKEN` placeholder.
