<h1 align="center">Agent Commerce Gateway</h1>

<p align="center">
  <strong>One backend. Agent-commerce protocols on the front. No proprietary middleman.</strong>
</p>

<p align="center">
  <a href="#quickstart"><img alt="Quickstart" src="https://img.shields.io/badge/quickstart-5%20minutes-2ea44f"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-supported-6b4fbb">
  <img alt="x402" src="https://img.shields.io/badge/x402-supported-0052ff">
  <img alt="Status" src="https://img.shields.io/badge/status-alpha-orange">
</p>

> **Beta.** `v0.2.0-beta` is experimental. Do not use it with production funds
> without an independent review. See [SECURITY.md](SECURITY.md).

---

## What it is, in ten seconds

You already have an HTTP API. AI agents want to **discover** it, **call** it and
**pay** for it — over protocols you did not write and do not want to maintain.

Agent Commerce Gateway sits in front of your existing API, in **your**
infrastructure, and does that for you. You describe an endpoint in a YAML file;
agents get an MCP tool and an x402 paywall. The money goes straight to your
wallet — the gateway never holds it, and never holds your keys.

```text
Your existing API → Agent Commerce Gateway → AI Agent
                MCP · x402 · receipts · doctor
```

## Demo

<!-- TODO(release): 15–30s GIF — left: buyer agent terminal, right: dashboard,
     overlay: on-chain settlement. Replace this block before tagging. -->

```text
[agent] Discovering resources over MCP...
[agent] Found: market_report — Premium Market Report (0.01 USDC)
[agent] Requesting resource...

[gateway] Payment required: 0.01 USDC → 0x7099…79C8
[buyer] Signing x402 authorisation...
[gateway] Payment verified
[gateway] Payment settled tx 0x4f2c…9ab1
[gateway] Calling merchant backend...
[gateway] Resource delivered

[receipt] payment: settled
[receipt] amount: 0.01 USDC
[receipt] merchant: 0x7099…79C8
[receipt] buyer balance 100.00 → 99.99 mUSDC
[receipt] merchant balance 0.00 → 0.01 mUSDC
```

The dashboard at <http://localhost:5173> shows the same request as it happens.
It polls the authenticated events route on a short interval rather than
streaming: a browser `EventSource` cannot send the admin token, and the operator
routes are closed without one — so the SSE endpoint is reachable by a
header-capable client, never by a browser. Polling is the dashboard's intended
path, not a degraded mode.

## Install

```bash
npx @devlab.group/agent-commerce --help # no install needed
npm install -g @devlab.group/agent-commerce # or install the `agent-commerce` binary
agent-commerce doctor
```

Requires **Node >= 22**. One package ships two things: the `agent-commerce`
CLI (`init`, `validate`, `doctor`, `demo`) and a library for embedding the
gateway in your own process. A default install is ~49 MB and pulls no
blockchain or wallet dependencies at all.

```ts
import { createGateway, loadConfig, receipts } from '@devlab.group/agent-commerce';

const config = await loadConfig({ path: 'config.yaml' });
const gateway = await createGateway({
  config,
  store: receipts({ path: './receipts.sqlite' }),
  paymentProviders: [],
  protocolAdapters: [],
});
const { url } = await gateway.listen;
```

### Optional peers — install only the rails you use

The MCP adapter and the x402 provider live on their own subpaths, because each
needs a dependency the rest of the package does not — the x402 rail brings the
whole EVM signing and RPC stack, which a gateway serving a free HTTP resource
has no business installing.

| You want                       | Install                        | Import                                     |
| ------------------------------ | ------------------------------ | ------------------------------------------ |
| gateway, config, receipts, CLI | `@devlab.group/agent-commerce` | `from '@devlab.group/agent-commerce'`      |
| expose resources as MCP tools  | `+ @modelcontextprotocol/sdk`  | `from '@devlab.group/agent-commerce/mcp'`  |
| accept x402 payments           | `+ @x402/core @x402/evm viem`  | `from '@devlab.group/agent-commerce/x402'` |

```bash
npm install @devlab.group/agent-commerce @modelcontextprotocol/sdk @x402/core @x402/evm viem
```

```ts
import { mcp } from '@devlab.group/agent-commerce/mcp';
import { x402 } from '@devlab.group/agent-commerce/x402';
```

Peers are pinned exactly: x402's schemas and EIP-712 domains cross this
boundary, so a version skew is a correctness problem rather than a convenience
one. Import a subpath without its
peer installed and Node fails at load naming the missing package — deliberately,
rather than starting a gateway that silently serves nothing.

## Quickstart

Requirements: **Node >= 22**, **npm 10**, **Docker**. Nothing else — no API
keys, no real money, no manual blockchain setup.

```bash
git clone <repo> && cd agent-commerce
npm install
docker compose up
```

Then, in a second terminal:

```bash
npm run agent-commerce -- doctor --config config-demo.yaml # verify the whole stack
npm run demo:agent # watch an agent buy something
```

<sub><b>Linux only</b>, and only if your user is not UID/GID 1000 (check with
<code>id -u && id -g</code>): export <code>DOCKER_UID=$(id -u) DOCKER_GID=$(id -g)</code>
before <code>docker compose up</code>. The chain-deploy step runs as that user so the
deployment manifest it writes stays host-writable rather than root-owned. Docker
Desktop on macOS and Windows translates permissions through its VM and does not
need this.</sub>

That is the whole thing. The stack is a private Anvil chain, a mock USDC token,
a demo merchant API, the gateway and a dashboard — all local and disposable.

To stop and wipe state: `docker compose down -v`.

## How it works

```text
        ┌──────────────────────────────────────────────────────┐
        │ AI Agent │
        └──────────────┬───────────────────────────────────────┘
                       │ MCP · HTTP + PAYMENT-SIGNATURE
        ┌──────────────▼───────────────────────────────────────┐
        │ Agent Commerce Gateway (yours) │
        │ │
        │ protocol adapters → ExecutionPipeline → … │
        │ │ │
        │ ┌─────────────────────┼──────────────┐ │
        │ ▼ ▼ ▼ │
        │ PaymentProvider BackendExecutor ReceiptStore │
        │ (x402) (bounded HTTP) (SQLite) │
        └────────┬─────────────────────┬───────────────────────┘
                 │ │
        buyer → merchant ┌──────▼───────────────┐
        (never through us) │ Your backend API │
                                └───────────────────────┘
```

Every protocol adapter converges on **one execution pipeline**. That is what
makes payment enforcement a property of the system rather than something each
adapter has to remember. Full detail in
[docs/architecture.md](docs/architecture.md).

## Configure a resource

```yaml
resources:
  market_report:
    name: Premium Market Report
    backend:
      type: http
      method: GET
      url: ${MERCHANT_API_BASE_URL}/api/report
      timeoutMs: 10000
    pricing:
      type: fixed
      amount: "0.01"
      currency: USDC
    expose: [http, mcp]
    payments: [x402]
```

That is the integration. No SDK in your backend, no rewrite.

```bash
npm run agent-commerce -- init # generate a config interactively
npm run agent-commerce -- validate # fails loudly, exits non-zero
```

See [docs/configuration.md](docs/configuration.md).

## Protocol support

| Protocol              | Status    | Pinned revision                                          |
| --------------------- | --------- | -------------------------------------------------------- |
| **MCP**               | Supported | `@modelcontextprotocol/sdk@1.30.0`                       |
| **x402**              | Supported | x402 v2 (`@x402/core`, `@x402/evm`), scheme `exact`, EVM |
| **HTTP**              | Supported | native routes                                            |
| UCP                   | Planned   | —                                                        |
| ACP · MPP · A2A · AP2 | Planned   | —                                                        |

"Planned" means **no code ships for it**. Each adapter reports its own
`supportedSpec`, `capabilities` and `unsupported` list at runtime via
`GET /.well-known/agent-commerce` and `agent-commerce doctor` — so the claim is
checkable, not marketing. Detail: [docs/protocols.md](docs/protocols.md).

## Payment model

- **Non-custodial.** The gateway never holds funds, and never asks for a
  merchant or buyer private key. `payTo` is your address.
- **Fail closed.** Missing, malformed, expired, replayed, wrong-amount,
  wrong-recipient, wrong-network and wrong-asset payments all fail — each with a
  test.
- **Replay-safe twice over.** EIP-3009 stops a double spend on-chain; the
  gateway additionally reserves a `replayKey` derived from the authorisation
  before it settles anything.
- **Real settlement in CI.** The end-to-end test asserts the buyer's balance
  falls and the merchant's rises by exactly the price, with a real transaction
  hash in the receipt. A log line saying "payment successful" would not count.

Detail: [docs/payment-flow.md](docs/payment-flow.md).

### Settled on public networks

Not a roadmap entry. Both of these moved 0.01 USDC from a buyer to a merchant
through a remote facilitator:

| Network      | Transaction                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| Base Sepolia | [`0xea41b234c4…`](https://sepolia.basescan.org/tx/0xea41b234c4645a4d335589ec9753646aa7cccd1b97e9e15823b88bff7b54a247) |
| Base         | [`0x57ec81c2a3…`](https://basescan.org/tx/0x57ec81c2a360d14d59a43cf4e24be09a6bd75cbe6185016372895bda73e42763)         |

In both, the gateway held no key, signed nothing and paid no gas — the buyer
signed an EIP-3009 authorisation offline holding no ETH, and the facilitator
broadcast it. Each run reads the buyer and merchant balances and the
transaction receipt back off the chain afterwards; the gateway's own report of
success is not the proof.

Reproduce with `npm run test:testnet` / `npm run test:mainnet` — both spend
real funds, skip themselves without credentials, and never run in CI.

## Diagnostics

```console
$ npm run agent-commerce -- doctor --config config-demo.yaml

PASS Config valid — 2 resource(s), merchant "Demo Data Store"
PASS Gateway healthy and ready at http://127.0.0.1:8080
PASS Backend 2/2 backend host(s) reachable
PASS Protocols http=on mcp=on (/mcp)
PASS Payments x402 v2 (scheme=exact) enabled — LOCAL on Base Sepolia (eip155:84532), destination=0x7099…79C8, facilitator=local
INFO Payments (MPP) planned — not implemented in v0.1
PASS Storage sqlite schema v1 writable; receipts=2
PASS Protocol versions reported by gateway /.well-known/agent-commerce

Score: 7/7 checks passed
```

That is real output, not an illustration. `doctor` also cross-checks the
gateway's *live* settlement configuration against what your local config
resolves to, and fails if they disagree — a diagnostic that passes while the
system is misconfigured is worse than none.

Exits non-zero if anything fails. `--json` for machines.

## Exposure and access

The demo binds everything to `127.0.0.1`. Before putting the gateway anywhere
reachable by anyone else, know the split:

- **Agent routes** (`/api/resources/:id/invoke`, `/mcp`) are unauthenticated by
  design — paid resources are protected by payment, not by a password.
- **Operator routes** (`/api/receipts`, `/api/events`, `/api/events/stream`) are
  the merchant's commerce ledger: payer addresses, amounts, settlement hashes.
  They require `server.adminToken`, and return **404** if none is configured.
- **Browsers** are governed by `server.allowedOrigins`, an explicit allowlist
  that defaults to empty.
- **There is no rate limiting.** A free resource is an unauthenticated proxy to
  your backend at whatever rate a caller chooses. Quotas and abuse controls
  belong in your API or your edge.

[SECURITY.md](SECURITY.md) states plainly what this does and does not protect.

## Development

```bash
npm run verify # contract + lint + typecheck + test
npm run test:e2e # deterministic end-to-end, boots its own chain
```

Foundry (`anvil`, `forge`, `cast`) is needed for the chain work.
See [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

**Now (v0.2.0-beta)** — MCP, x402 v2, settlement on the local chain, Base
Sepolia and Base mainnet, receipts, doctor, deterministic demo.

**Next** — OpenAPI import · a stronger conformance suite · a `doctor` GitHub
Action · UCP · MPP · ACP · A2A · AP2 · Shopify and WooCommerce examples ·
PostgreSQL · richer observability.

New protocols land only after the adapter model survives real use. Scope
discipline is a release requirement, not a mood.

## Documentation

|                                                |                                             |
| ---------------------------------------------- | ------------------------------------------- |
| [Architecture](docs/architecture.md)           | how the pieces fit                          |
| [Payment flow](docs/payment-flow.md)           | the paid round trip, and every way it fails |
| [Protocols](docs/protocols.md)                 | exactly what is and is not supported        |
| [Configuration](docs/configuration.md)         | `config.yaml` reference                     |
| [Security model](docs/security.md)             | trust boundaries, and what we do not defend |
| [Contracts](docs/contracts.md)                 | the frozen cross-package contract           |
| [Adapter guide](docs/contributing-adapters.md) | add a protocol or a payment rail            |

## Licence

[Apache-2.0](LICENSE).
