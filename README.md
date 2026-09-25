<h1 align="center">Agent Commerce Gateway</h1>

<p align="center">
  <strong>One backend. Multiple agent-commerce protocols. Self-hosted and non-custodial.</strong>
</p>

<p align="center">
  <a href="#quickstart"><img alt="Quickstart" src="https://img.shields.io/badge/quickstart-5%20minutes-2ea44f"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-supported-6b4fbb">
  <img alt="x402" src="https://img.shields.io/badge/x402-supported-0052ff">
  <img alt="MPP" src="https://img.shields.io/badge/MPP-experimental-f0a30a">
  <img alt="A2A" src="https://img.shields.io/badge/A2A-experimental-f0a30a">
  <img alt="ACP" src="https://img.shields.io/badge/ACP-experimental-f0a30a">
  <img alt="AP2" src="https://img.shields.io/badge/AP2-experimental-f0a30a">
</p>

## What it is, in ten seconds

You already have an HTTP API. Agent Commerce Gateway lets AI agents discover,
call and pay for it without adding those protocols to your backend.

Run the gateway in your infrastructure and describe each endpoint in YAML, or
generate draft resource definitions from OpenAPI. Resources can be exposed over
HTTP, MCP or experimental A2A; dedicated resources can implement experimental
ACP checkout operations. Paid resources use x402 or experimental MPP and can
also require an AP2 mandate proving that the buyer approved the purchase. Funds
go directly to the merchant wallet; the gateway never holds them or your keys.

```text
Your existing API → Agent Commerce Gateway → AI Agent
    MCP · A2A · ACP · x402 · MPP · AP2 · receipts · doctor
```

## Demo

```text
[agent] Discovering resources over MCP...
[agent] Found: market_report - Premium Market Report (0.01 USDC)
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
It polls the authenticated events route rather than streaming, because a browser
cannot send the admin token over `EventSource`; see
[why the stream is polled](SECURITY.md#the-live-event-stream-is-polled-not-streamed).

## Install

```bash
npx @devlab.group/agent-commerce --help # no install needed
npm install -g @devlab.group/agent-commerce # or install the `agent-commerce` binary
agent-commerce doctor
```

Requires **Node >= 22**. The package includes the `agent-commerce` CLI
(`init`, `validate`, `doctor`, `demo`) and a library for embedding the gateway.
The default install excludes optional protocol, payment and authorization
peers. The OpenAPI parser is a regular dependency because import is part of the
CLI.

```ts
import { createGateway, loadConfig, receipts } from '@devlab.group/agent-commerce';

const config = await loadConfig({ path: 'config.yaml' });
const store = receipts({ path: './receipts.sqlite' });
// Initialize before use so an incompatible SQLite schema fails at startup
await store.init();

const gateway = await createGateway({
  config,
  store,
  paymentProviders: [],
  protocolAdapters: [],
});
const { url } = await gateway.listen();
```

### Optional peers

Components with extra dependencies use separate subpaths, so a gateway serving
free HTTP resources does not install MCP, EVM, JOSE or SD-JWT packages.

| You want                                | Install                            | Import                                     |
| --------------------------------------- | ---------------------------------- | ------------------------------------------ |
| gateway, config, receipts, CLI          | `@devlab.group/agent-commerce`     | `from '@devlab.group/agent-commerce'`      |
| expose resources as MCP tools           | `+ @modelcontextprotocol/sdk`      | `from '@devlab.group/agent-commerce/mcp'`  |
| accept x402 payments                    | `+ @x402/core @x402/evm viem`      | `from '@devlab.group/agent-commerce/x402'` |
| accept MPP payments                     | `+ mppx viem @x402/core @x402/evm` | `from '@devlab.group/agent-commerce/mpp'`  |
| verify AP2 mandates, sign checkout JWTs | `+ jose @sd-jwt/core canonicalize` | `from '@devlab.group/agent-commerce/ap2'`  |
| authenticate to a CDP facilitator       | `+ @coinbase/x402`                 | (no import - loaded on demand)             |

MPP settles through an x402 facilitator, so its entry also needs the x402
peers.

```bash
npm install @devlab.group/agent-commerce @modelcontextprotocol/sdk @x402/core @x402/evm viem
```

```ts
import { mcp } from '@devlab.group/agent-commerce/mcp';
import { x402 } from '@devlab.group/agent-commerce/x402';
import { ap2 } from '@devlab.group/agent-commerce/ap2';
```

AP2 peers remain optional because a deployment without mandate-gated resources
does not need JOSE or SD-JWT support.

Peers are pinned exactly: x402's schemas and EIP-712 domains cross this
boundary, so a version skew is a correctness problem rather than a convenience
one. Importing a subpath without its peer fails at load time and names the
missing package.

`@coinbase/x402` has no subpath import. It is loaded dynamically only for
`facilitator.auth.type: cdp` and brings the larger CDP dependency tree. A
facilitator with a static token can use `auth.type: bearer` without it.

## Quickstart

Requirements: **Node >= 22**, **npm 10**, **Docker**. Nothing else - no API
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

<sub><b>Linux:</b> if your UID/GID is not 1000, export
<code>DOCKER_UID=$(id -u) DOCKER_GID=$(id -g)</code> before
<code>docker compose up</code>. This keeps the generated deployment manifest
host-writable. Docker Desktop does not need this.</sub>

The disposable local stack includes Anvil, MockUSDC, a demo merchant API, the
gateway and a dashboard.

To stop and wipe state: `docker compose down -v`.

## How it works

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                                   AI Agent                                   │
└───────────────────────────────────────┬──────────────────────────────────────┘
                                        │  MCP · A2A · ACP · HTTP
                                        │  payment proof
                                        │  Agent-Authorization
┌───────────────────────────────────────▼──────────────────────────────────────┐
│                        Agent Commerce Gateway (yours)                        │
│                                                                              │
│                   protocol adapters  →  ExecutionPipeline                    │
│                                                 │                            │
│             ┌────────────────────┬──────────────┴──┬────────────────┐        │
│             ▼                    ▼                 ▼                ▼        │
│   AuthorizationProvider   PaymentProvider   BackendExecutor   ReceiptStore   │
│           (ap2)             (x402, mpp)     (bounded HTTP)      (SQLite)     │
└───────────────────────────────────────┬──────────────────────────────────────┘
                                        │
                             ┌──────────▼─────────┐
                             │  Your backend API  │
                             └────────────────────┘
```

Every protocol adapter uses one execution pipeline, so payment enforcement does
not depend on the adapter. The buyer pays the merchant directly on-chain; the
gateway holds neither the funds nor a buyer or merchant key. See
[Architecture](docs/architecture.md).

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

Already have an OpenAPI description? Generate the resources from it
(**experimental**):

```bash
agent-commerce import openapi ./openapi.yaml
```

It writes a reviewable `resources:` fragment with path, query and JSON body
bindings and supported schemas. It omits `pricing`, `expose` and credentials;
the source document cannot decide price or exposure. See
[OpenAPI import](docs/openapi-import.md) for the supported subset.

See [docs/configuration.md](docs/configuration.md).

## Protocol support

| Protocol | Status       | Pinned revision                                                           |
| -------- | ------------ | ------------------------------------------------------------------------- |
| **HTTP** | Supported    | native routes                                                             |
| **MCP**  | Supported    | `@modelcontextprotocol/sdk@1.30.0`                                        |
| **x402** | Supported    | x402 v2 (`@x402/core`, `@x402/evm`), scheme `exact`, EVM                  |
| **MPP**  | Experimental | `mppx@0.10.1`, `charge` + `evm` + EIP-3009, USDC on Base Sepolia and Base |
| **A2A**  | Experimental | A2A v1.0.0, binding `JSONRPC`, method `SendMessage`                       |
| **ACP**  | Experimental | ACP `2026-04-17`, REST checkout + discovery                               |
| **AP2**  | Experimental | AP2 `v0.2.0`, Direct Checkout Mandate verification                        |
| UCP      | Planned      | no implementation                                                         |

[AP2](docs/ap2.md) is an authorization method, not a transport. It verifies a
mandate before a paid resource settles; the gateway does not issue the mandate
or its Checkout Receipt.

The experimental entries above ship off by default with documented subsets:
[A2A](docs/protocols.md#a2a), [ACP](docs/protocols.md#acp),
[AP2](docs/ap2.md#not-implemented) and [MPP](docs/protocols.md#mpp). Supported
[MCP](docs/protocols.md#mcp) and [x402](docs/protocols.md#x402) are also scoped.
ACP exposes only its five checkout operations; merchant `payment_data` is never
converted into a gateway payment proof.

`GET /.well-known/agent-commerce` reports `supportedSpec`, `capabilities` and
`unsupported` for registered adapters and providers. `agent-commerce doctor`
prints the `unsupported` lists for A2A, ACP and AP2.

## Payment model

- **Non-custodial.** The gateway never holds funds, and never asks for a
  merchant or buyer private key. `payTo` is your address.
- **Fail closed.** Missing, malformed, expired, replayed, wrong-amount,
  wrong-recipient, wrong-network and wrong-asset payments are rejected.
- **Replay-safe twice over.** EIP-3009 stops a double spend on-chain; the
  gateway additionally reserves a `replayKey` derived from the authorisation
  before it settles anything.
- **On-chain settlement in CI.** The end-to-end test asserts the buyer's balance
  falls and the merchant's rises by exactly the price, with a real transaction
  hash in the receipt. A log line saying "payment successful" would not count.
- **One selected rail per resource.** A resource can name several rails, such as
  `payments: [x402, mpp]`; the first enabled one serves it, and nothing selects
  or falls back between rails per request.
- **Authorization is separate from payment.** A resource can also require an
  AP2 mandate, verified before settlement and spendable exactly once. It never
  moves money and never unlocks a resource on its own - the payment still has
  to be real.

## Public networks

Same gateway, same pipeline - a different `network` and a facilitator that is
not this process. No code changes, and no "live mode" to switch on.

### It has actually settled

These transactions each moved 0.01 USDC from a buyer to a merchant through a
remote facilitator:

| Rail | Network      | Transaction                                                                                                           |
| ---- | ------------ | --------------------------------------------------------------------------------------------------------------------- |
| x402 | Base Sepolia | [`0xea41b234c4…`](https://sepolia.basescan.org/tx/0xea41b234c4645a4d335589ec9753646aa7cccd1b97e9e15823b88bff7b54a247) |
| x402 | Base         | [`0x57ec81c2a3…`](https://basescan.org/tx/0x57ec81c2a360d14d59a43cf4e24be09a6bd75cbe6185016372895bda73e42763)         |
| MPP  | Base Sepolia | [`0x5d9fcd111b…`](https://sepolia.basescan.org/tx/0x5d9fcd111b615bb8fc9e56d55096f119fc81c3c72c334f813cfaecee402d0ac3) |
| MPP  | Base         | [`0xf4255bd7ec…`](https://basescan.org/tx/0xf4255bd7ec46ed06505dedfb5f9537924bd2633816e7952ec6f2b468395b1087)         |

The buyer signed each EIP-3009 authorisation without ETH; the remote facilitator
paid gas and broadcast it. The gateway path received no buyer or merchant key.
The public-network smoke suites verify balance changes and fetch the transaction
receipt from the chain instead of trusting the gateway's response.

Reproduce with `npm run test:testnet` / `npm run test:mainnet` - both spend
real funds, skip themselves without credentials, and never run in CI.

### The facilitator model

A **facilitator** verifies the buyer's authorisation and broadcasts the
transfer. It is the only component that needs gas, and it is never this
gateway on a public network.

| `facilitator.mode` | Who signs                           | Where it is allowed      |
| ------------------ | ----------------------------------- | ------------------------ |
| `local`            | this process, with an Anvil dev key | the local dev chain only |
| `remote`           | an HTTP facilitator you point at    | anywhere                 |

With `remote`, the gateway holds no facilitator signing key. The buyer signs an
EIP-3009 authorisation without ETH, and the facilitator pays gas. Because the
authorisation fixes the recipient, amount and chain, the facilitator cannot
redirect the transfer. It can see authorisations and refuse service.

Remote facilitator auth supports `none`, `bearer` and `cdp`. CDP signs a fresh
JWT per request and conditionally loads `@coinbase/x402`; bearer auth needs no
extra peer. Other types are rejected at config load.

### Base Sepolia

```yaml
payments:
  x402:
    enabled: true
    network: eip155:84532
    rpcUrl: https://base-sepolia-rpc.publicnode.com # health checks only
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" # Circle USDC
    assetName: USDC
    assetVersion: "2"
    assetDecimals: 6
    payTo: ${MERCHANT_WALLET}
    maxTimeoutSeconds: 300
    facilitator:
      mode: remote
      url: https://x402.org/facilitator
      auth: { type: none }
```

Full config in [`examples/base-sepolia/`](examples/base-sepolia/). Test USDC
from [faucet.circle.com](https://faucet.circle.com); the buyer needs no ETH.
`npm run test:testnet` drives the whole flow and reads the result back off the
chain.

Chain id 84532 belongs to **both** Base Sepolia and this project's local dev
chain, deliberately. Nothing infers "public network" from it - `local`,
`testnet` and `mainnet` are derived from the network *and* the facilitator
together, and reported by `doctor`, `health()` and `/.well-known`.

### Base mainnet

Mainnet moves real funds. Config validation requires:

| Required                                        |                                                                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `allowMainnet: true`                            | mainnet is never a default                                                                                     |
| `facilitator.mode: remote`                      | `local` needs a funded gas key inside this process                                                             |
| an HTTPS `facilitator.url`                      |                                                                                                                |
| `allowUnauthenticatedFacilitator: true`         | only if that facilitator takes no credential                                                                   |
| a non-development destination (`payTo` or `recipient`) |                                                                                                         |
| Base USDC with `assetName: "USD Coin"` and `assetVersion: "2"` | the buyer signs this EIP-712 domain; `"USDC"` is wrong on Base |

Full config in [`examples/base-mainnet/`](examples/base-mainnet/), and
[`examples/base-mainnet-payai/`](examples/base-mainnet-payai/) for an
unauthenticated facilitator. The mainnet smoke suites cover x402 and MPP and
spend real USDC when their opt-ins and credentials are present.

`agent-commerce validate` reports any of the above before anything starts, and
`doctor` prints `LIVE MAINNET MODE - REAL FUNDS`.

> Neither public-network suite runs in CI - there is no workflow and there must
> not be one. A workflow means a funded key in repository secrets, spendable by
> anyone with write access. Both suites run from the machine that holds the
> wallet, and skip themselves without credentials.

## Diagnostics

```console
$ npm run agent-commerce -- doctor --config config-demo.yaml

PASS  Config               valid - 2 resource(s), merchant "Demo Data Store" (using local chain manifest .deploy/local.json for X402_ASSET, X402_ASSET_NAME, X402_ASSET_VERSION, X402_ASSET_DECIMALS, MERCHANT_WALLET, X402_FACILITATOR_PRIVATE_KEY)
PASS  Gateway              healthy and ready at http://127.0.0.1:8080
PASS  Backend              2/2 backend host(s) reachable
PASS  Protocols            http=on mcp=on (/mcp) a2a=off acp=off
INFO  A2A                  disabled
INFO  ACP                  disabled
INFO  AP2                  disabled
PASS  Payments             x402 v2 (scheme=exact) enabled - LOCAL dev chain (eip155:84532, chain id shared with Base Sepolia), destination=0x7099…79C8, facilitator=local
INFO  Payments (MPP)       MPP not configured
PASS  Storage              sqlite schema v1 writable; receipts=2
PASS  Protocol versions    reported by gateway /.well-known/agent-commerce

Score: 7/7 checks passed
```

`doctor` cross-checks the gateway's live settlement configuration against the
resolved local config and fails if they differ.

Exits non-zero if anything fails. `--json` for machines.

## Exposure and access

The demo binds everything to `127.0.0.1`. Before putting the gateway anywhere
reachable by anyone else, know the split:

- **Agent routes** (`/api/resources/:id/invoke`, `/mcp`, the A2A mount) are
  unauthenticated by design - paid resources are protected by payment, not by a
  password. ACP is the exception: its checkout routes require a bearer token.
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

**Now** - MCP, x402 v2, settlement on the local chain, Base Sepolia and Base
mainnet, receipts, doctor, deterministic demo, experimental A2A v1.0.0 and ACP
`2026-04-17` checkout adapters, experimental AP2 v0.2.0 mandate verification,
experimental MPP `charge` payments, and experimental OpenAPI import.

**Next** - a `doctor` GitHub Action · UCP ·
autonomous-mode AP2 (open mandates, agent key binding, constraint evaluation) ·
more of ACP (carts, feed, delegated payment) · Shopify and WooCommerce examples ·
PostgreSQL · richer observability · multi-file and remote OpenAPI sources.

New protocols land only after the adapter model survives real use. Scope
discipline is a release requirement, not a mood.

## Documentation

|                                                |                                             |
| ---------------------------------------------- | ------------------------------------------- |
| [Architecture](docs/architecture.md)           | how the pieces fit                          |
| [Payment flow](docs/payment-flow.md)           | the paid round trip and failure paths       |
| [Protocols](docs/protocols.md)                 | supported and unsupported protocol features |
| [AP2](docs/ap2.md)                             | mandate verification and the trust model    |
| [Configuration](docs/configuration.md)         | `config.yaml` reference                     |
| [OpenAPI import](docs/openapi-import.md)       | generate resources from an existing API     |
| [Security model](docs/security.md)             | trust boundaries, and what we do not defend |
| [Contracts](docs/contracts.md)                 | the frozen cross-package contract           |
| [Adapter guide](docs/contributing-adapters.md) | add a protocol or a payment rail            |

## Licence

[Apache-2.0](LICENSE).
