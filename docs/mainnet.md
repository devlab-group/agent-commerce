# Base mainnet

Real funds. Read this before the config.

> **Status.** Implemented and guarded; **not demonstrated**. No payment has
> settled on `eip155:8453` from this repository. [Has it actually
> settled?](#has-it-actually-settled) is updated only when one has.

## What is different from a testnet

Two things, and neither is a flag.

**The gateway holds no key, and cannot.** `facilitator.mode: local` signs with
a key this process holds — a hot wallet inside the resource server, which is
the arrangement the non-custodial design exists to avoid. It is refused on
mainnet outright, not warned about. A mainnet deployment settles through a
remote facilitator, which broadcasts and pays the gas.

**Nothing is defaulted.** On a network where money is real, a default is a way
to lose it by accident. Every requirement below is checked at config load, so
`agent-commerce validate` reports it and the gateway does not start:

| Refused | Because |
|---|---|
| `allowMainnet` absent or false | mainnet is never a default |
| `facilitator.mode: local` | a hot wallet inside the resource server |
| `facilitator.auth.type: none` | an unauthenticated production facilitator |
| a non-HTTPS `facilitator.url` | authorisations and settlement results in the clear |
| an empty credential | a blank token reaches the facilitator as "unauthenticated" |
| a well-known Anvil `payTo` | its private key is public knowledge |
| any `asset` but USDC on Base | settling in an unintended token |

Seen from the outside:

```console
$ agent-commerce validate --config config.yaml
FAIL  CONFIG_INVALID: payments.x402: network "eip155:8453" (Base) settles real funds.
      Set payments.x402.allowMainnet: true to acknowledge this explicitly — it is
      never the default.
```

## Configuration

A complete file is in
[`examples/base-mainnet/config.yaml`](../examples/base-mainnet/config.yaml).

```yaml
payments:
  x402:
    network: eip155:8453
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" # USDC on Base
    assetName: USDC
    assetVersion: "2"
    assetDecimals: 6
    payTo: ${MERCHANT_WALLET}
    maxTimeoutSeconds: 600
    allowMainnet: ${ALLOW_X402_MAINNET}
    facilitator:
      mode: remote
      url: ${X402_FACILITATOR_URL}
      auth:
        type: cdp
        apiKeyId: ${CDP_API_KEY_ID}
        apiKeySecret: ${CDP_API_KEY_SECRET}
```

An unresolved `${VAR}` fails config loading rather than resolving to an empty
string, so a missing credential is a startup failure, never a silently
unauthenticated facilitator.

## Choosing a facilitator

There is no free mainnet facilitator equivalent to the public testnet one:
`https://x402.org/facilitator` advertises `eip155:84532` and nothing on
mainnet. Whichever you pick is a real counterparty that sees every payment
authorisation you handle, and probably sends you a bill.

Three auth types exist:

| `auth.type` | For | Installs |
|---|---|---|
| `none` | facilitators that take no credential | nothing |
| `bearer` | any facilitator with a static token | nothing |
| `cdp` | Coinbase Developer Platform | `@coinbase/x402` |

**`bearer` is the cheaper path in every sense.** `cdp` exists because CDP signs
a fresh JWT per request over method + host + path, which a static header cannot
express — it is not a preference for Coinbase, and nothing in the architecture
is shaped around them.

### The `@coinbase/x402` dependency

It is an **optional peer**, imported dynamically only when `auth.type: cdp` is
configured. Nobody else installs it, and it is absent from the default install.

Know what it brings: `@coinbase/x402` → `@coinbase/cdp-sdk` → `axios`, which at
the time of writing carries ten high-severity advisories, plus a Solana client
tree this project has no use for. That is a real supply-chain surface on the
highest-stakes path in the system. If your facilitator accepts a static token,
`bearer` avoids all of it.

A missing peer is a *configuration* failure, surfaced through `health()` and
`/ready` before any buyer signs anything — never an exception inside `verify()`
with an authorisation already spent.

## The smoke test

```bash
export ALLOW_X402_MAINNET=true
export X402_MAINNET_BUYER_PRIVATE_KEY=0x...   # funded with USDC on Base
export X402_MAINNET_MERCHANT_ADDRESS=0x...
export X402_FACILITATOR_URL=https://...
export CDP_API_KEY_ID=...  CDP_API_KEY_SECRET=...   # or X402_FACILITATOR_TOKEN
npm run test:mainnet
```

**Every run spends `X402_MAINNET_AMOUNT` (default `0.01`) of real USDC.** It
skips itself, naming what is missing, unless all of the above are set — five
separate deliberate acts.

It proves, in order: the guard refuses a config that has not opted in ·
authentication reaches the facilitator · a payment settles on Base · the
receipt carries the settlement reference and a delivery timestamp · the
resource is delivered exactly once · the same authorisation presented again is
refused with no second transfer · no credential appears in anything logged.

Balances and the transaction receipt are read back from the chain. The
gateway's own report of success is not the proof, and `retry: 0` is set
deliberately — a retried settlement is a second payment.

In CI it is `.github/workflows/mainnet-smoke.yml`: `workflow_dispatch` only,
behind a `mainnet` environment (add a required reviewer), requiring the literal
string `SPEND REAL FUNDS` typed into an input, serialised so two runs cannot
share one nonce space, and failing rather than passing when its secrets are
absent.

## Keys

The buyer key is read from the environment, never written to a config file,
never logged, and never included in an assertion message. The merchant side
never needs a key at all — only an address to settle to. A mainnet key must
never appear in this repository, in `.env.testnet`, or in a config file.

## Has it actually settled?

**No.** Every settlement this project has performed was on the local
deterministic chain or on Base Sepolia ([testnet.md](testnet.md)).

The mainnet path is implemented, guarded, and covered by a smoke test that has
never been run against a funded wallet. When it has, this section carries the
transaction rather than a claim.
