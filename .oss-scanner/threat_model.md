# Threat model: Agent Commerce Gateway

The full security notes are in the repository's `SECURITY.md` and `docs/security.md`. This file summarizes them for the scanner.

## What this project does and where untrusted input enters

Agent Commerce Gateway is a self-hosted TypeScript gateway that sits in front of a merchant's existing HTTP API and sells calls to it to AI agents. Agents reach it over plain HTTP (`/api/resources/:id/invoke`), MCP (`/mcp`), A2A (`/a2a`) and, when enabled, ACP checkout routes. Paid resources take x402 v2 (`exact`, EVM / EIP-3009) or MPP payments, and can also require an AP2 Checkout Mandate. The gateway never holds merchant or buyer funds: payments go from the buyer to the merchant's configured address.

- **Untrusted:** everything a caller sends.
  - HTTP, MCP JSON-RPC, A2A JSON-RPC and ACP request bodies.
  - Path parameters, query strings and resource inputs.
  - `Host` and `Origin` headers.
  - Payment proofs: x402 `PAYMENT-SIGNATURE`, MPP `Authorization: Payment …` credentials, and the `_payment` field on MCP and A2A.
  - AP2 mandates (SD-JWT).
- **Semi-trusted:**
  - responses from the payment facilitator and the RPC node;
  - responses from the merchant backend (the built-in executor enforces a timeout and a 1 MiB body cap).
- **Trusted:** the operator's configuration file and environment, including backend URLs, admin and ACP tokens, keys and facilitator settings.

## Components that matter most / least

- **Most important:**
  - **The payment path:** `src/core` (request pipeline), `src/payments/x402`, `src/payments/mpp`.
    - Verify, then replay reservation, then settle, then deliver.
    - Every failure must fail closed.
    - Delivery must happen at most once per payment authorization.
  - **AP2 verification:** `src/authorization/ap2`.
  - **Protocol adapters:** `src/protocols/mcp`, `src/protocols/a2a`, `src/protocols/acp`, `src/protocols/http.ts`.
  - **Access control and routing:** `src/gateway`.
    - Host-header (DNS-rebinding) validation in `access-control.ts`.
    - The admin token on `/api/receipts` and `/api/events`.
    - The ACP bearer token.
  - **Storage** (`src/storage`): receipts, events, replay keys.
  - **Secret redaction** in logs and receipts.
- **Lower priority:**
  - `src/cli` (operator tooling);
  - `src/openapi` (imports an operator-supplied OpenAPI document);
  - `src/config`, which still matters because invalid configuration must fail startup.
- **Out of scope:**
  - `demo/`, `examples/`, `scripts/`, `contracts/` (local demo chain);
  - the deliberately public Anvil development keys;
  - the internals of third-party SDKs (x402, MCP SDK, mppx). How the gateway uses them is in scope.

## How to exercise it

- `npm test` runs the unit, integration and conformance suites (Vitest). The local-chain suites spawn Anvil, which this image installs.
- `tests/conformance/` drives the MCP, A2A and ACP adapters with the official client SDKs.
- `config-demo.yaml` describes a complete local setup. `npm run agent-commerce -- doctor --config config-demo.yaml` checks it.

## How we rate severity

- **Critical:**
  - a paid resource delivered without a successfully verified and settled payment;
  - a payment that settles to a recipient, amount, asset or network other than the configured one;
  - one payment authorization or AP2 mandate unlocking more than one delivery;
  - an AP2 requirement bypassed;
  - any path that discloses a private key.
- **High:**
  - unauthenticated access to the operator routes (`/api/receipts`, `/api/events`) or disclosure of `server.adminToken`;
  - an ACP bearer-token bypass;
  - a bypass of the Host-header validation;
  - credentials, payment proofs or tokens written to logs or receipts despite redaction;
  - code execution or path traversal reachable from untrusted input.
- **Medium:** denial of service from unauthenticated input that gets past the configured limits (body size, timeouts, batch handling); disclosure of non-secret configuration.
- **Low:** findings that need a malicious or careless operator configuration; overly detailed error messages without secrets.

## Anything to leave alone

`SECURITY.md` → "What the gateway does not protect against" lists behavior that is documented and intended. Please do not report it:
- SSRF through backend URLs the operator configured;
- no buyer vetting or KYC;
- irreversible on-chain settlement;
- the documented divergence between payment and delivery in the `upfront` and `authorization` flows;
- reserved authorizations never being released;
- a compromised host;
- the demo dashboard's `VITE_ADMIN_TOKEN` placeholder.
