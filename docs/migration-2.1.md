# Upgrading from 2.0 to 2.x

2.1 added x402 payments on more EVM networks, Permit2, Solana and NEAR, several
offers per resource, and health per offer. The changes below came in 2.1, remain
in later 2.x releases, and can break a 2.0 configuration, integration or type
check. Review them before upgrading.

| Change                                                                                  | Affects                                                              |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [The local chain is `eip155:31337`](#the-local-chain-is-eip15531337)                    | local development on Anvil, x402 and MPP                             |
| [Public networks settle only in their USDC](#public-networks-settle-only-in-their-usdc) | another token on Base Sepolia                                        |
| [Prices in USDC need a USDC label](#prices-in-usdc-need-a-usdc-label)                   | resources priced in neither `USD` nor `USDC` on Base or Base Sepolia |
| [URLs that cannot work are refused](#urls-that-cannot-work-are-refused)                 | `auth.type: cdp` at another URL; an RPC URL that is not http(s)      |
| [MPP settles before the backend](#mpp-settles-before-the-backend)                       | MPP resources without `paymentFlow`                                  |
| [Payments in USDC record `USDC`](#payments-in-usdc-record-usdc)                         | receipts and events of resources not priced in `USDC`                |
| [`destination` is optional](#destination-is-optional)                                   | TypeScript code reading payment requirements                         |
| [`assetName` and `assetVersion` are optional](#assetname-and-assetversion-are-optional) | TypeScript code and discovery clients reading x402 settings          |

## Configuration

### The local chain is `eip155:31337`

2.0 ran the local Anvil chain under Base Sepolia's id, `eip155:84532`. Since
2.1, that id always means the public Base Sepolia testnet, and the local chain
uses Anvil's default id, `eip155:31337`. Config load refuses `eip155:84532` with
`facilitator.mode: local`, for x402 and MPP, and the message names the local
chain id.

To migrate a local setup:

1. Set the network, usually `X402_NETWORK`, to `eip155:31337`.
2. Start Anvil with its default chain id, as `npm run chain:start` does, and
   deploy the mock token again with `npm run chain:deploy`.
3. Buyer code that sets the chain id itself must use 31337; clients that read
   it from the challenge need no change.

A setup that settles on the real Base Sepolia needs a remote facilitator, as in
2.0.

### Public networks settle only in their USDC

2.0 required the network's USDC on mainnet only. Since 2.1, config load also
refuses another token on a public testnet, such as a mock token on Base Sepolia.
Omit the asset fields to settle in the network's USDC, or use the local chain or
a network you declare under `payments.x402.networks` (see
[configuration.md](configuration.md#network-and-facilitator)).

### Prices in USDC need a USDC label

2.0 let a resource keep any currency label when its option named the network's
USDC as `asset`, and charged the price in USDC at face value. Since 2.1, the
gateway treats that option like one that omits the asset: price its resources in
`USDC` or `USD`.

### URLs that cannot work are refused

Config load refuses two settings that 2.0 accepted but could not use:

- `facilitator.auth.type: cdp` with a `url` other than
  `https://api.cdp.coinbase.com/platform/v2/x402`, the URL `@coinbase/x402`
  signs for.
- An `rpcUrl` that is not an `http://` or `https://` URL.

### MPP settles before the backend

2.0 ran an MPP resource's backend before settling, like x402. Since 2.1, MPP
defaults to `upfront`, which settles first: the `charge` intent counts a backend
call before payment as partial access. A backend failure now leaves the payment
settled, and the receipt records the failed delivery. To keep the 2.0 order, set
`paymentFlow: authorization` under `payments.mpp` or on the resource; see
[MPP](protocols/mpp.md) for what that order costs.

## Receipts and events

### Payments in USDC record `USDC`

In 2.0 a payment recorded the resource's `pricing.currency`. Since 2.1, an x402
payment in the network's USDC records `USDC` whatever the resource's label. When
the label differs, as with `USD`, the settlement keeps the resource's price as
`metadata.quote`. Payments in other tokens still record the resource's label.
Code that reads `currency` from receipts, events or the payment summary returned
with a delivery should accept `USDC`.

## TypeScript

### `destination` is optional

`PaymentRequirement.destination` and
`PaymentRequiredEnvelope.payment.destination` are optional. A challenge with
several x402 offers has no single destination, network or asset; read each
offer in `accepts`. Single-offer and selected requirements still carry all
three. The envelope fields are deprecated. With `strictNullChecks`, code that
uses either field as a `string` must handle `undefined`.

### `assetName` and `assetVersion` are optional

They are optional in `X402ProviderOptions`, `X402OfferOptions`,
`GatewayConfig.payments.x402` and its `options`, and in
`GET /.well-known/agent-commerce`. A Permit2 offer has neither, because Permit2
signs under its own domain. EIP-3009 offers still need both: config load fills
them from the network's USDC or requires them, and provider construction
refuses an EIP-3009 offer without them.

`X402ProviderOptions.asset` and `payTo` also widened from `` `0x${string}` `` to
`string`, to carry Solana and NEAR addresses; code reading either as an EVM
address must narrow it.

## Other behavior changes

- A rejected x402 attempt, after a backend failure or a refused settlement, can
  be retried with the same proof; 2.0 answered `402`. A custom `ReceiptStore`
  that ignores `reclaimRejected` still refuses these retries.
- `PAYMENT_PROVIDER_UNAVAILABLE` and `AUTHORIZATION_PROVIDER_UNAVAILABLE` on the
  invoke route carry `Retry-After: 5`.
- A missing Permit2 allowance answers `412` with a fresh `PAYMENT-REQUIRED`.
- When 256 unpaid A2A extension tasks are pending, a new purchase fails with
  `GATEWAY_BUSY` instead of evicting the oldest task.
- `/.well-known/agent-commerce` publishes each rail's `paymentFlow`,
  per-resource overrides, and, with several offers, each offer with its health
  status.
