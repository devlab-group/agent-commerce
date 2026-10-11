# Public-network smoke tests

`npm run test:testnet` and `npm run test:mainnet` spend funds on public x402
payments and verify settlement on-chain. Run them manually on the wallet
holder's machine, never in CI, where funded keys would enter repository
secrets. Without settings, both skip and list each target's requirements
(with `--reporter=verbose`).

The x402 harness lives in `tests/fixtures/x402/smoke/`. Separate MPP suites
list their settings in file headers.

## Targets

| Target                   | Network                                   | Default facilitator                         | Runs unnamed |
| ------------------------ | ----------------------------------------- | ------------------------------------------- | ------------ |
| `base-sepolia`           | `eip155:84532`, EIP-3009                  | `https://x402.org/facilitator`              | yes          |
| `base-sepolia-permit2`   | `eip155:84532`, Permit2                   | `https://x402.org/facilitator`              | no           |
| `arbitrum-sepolia`       | `eip155:421614`, EIP-3009                 | `https://facilitator.payai.network`         | no           |
| `solana-devnet`          | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | `https://x402.org/facilitator`              | yes          |
| `near-testnet`           | `near:testnet`                            | the SDK's, started by the suite             | yes          |
| `base` (mainnet)         | `eip155:8453`, EIP-3009                   | none: `X402_FACILITATOR_URL`                | no           |
| `base-permit2` (mainnet) | `eip155:8453`, Permit2                    | none: `X402_FACILITATOR_URL`                | no           |
| `solana` (mainnet)       | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | none: `X402_SOLANA_MAINNET_FACILITATOR_URL` | no           |
| `near` (mainnet)         | `near:mainnet`                            | the SDK's, started by the suite             | no           |

Every target settles one payment in its network's default USDC, priced in `USD`.

Set `X402_SMOKE_TARGETS` to a comma-separated list for a release check:
unknown targets or missing settings fail before signing, so the check cannot
pass by skipping. Without it, `test:testnet` runs configured targets marked
"runs unnamed"; `test:mainnet` runs nothing. Mainnet also requires
`ALLOW_X402_MAINNET=true`.

## Settings

| Target                 | Required                                                                                                                                                    | Optional                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| EVM testnets           | `X402_TESTNET_BUYER_PRIVATE_KEY`, `X402_TESTNET_MERCHANT_ADDRESS`                                                                                           | `X402_TESTNET_RPC_URL`, `X402_TESTNET_FACILITATOR_URL` (Base Sepolia); `X402_ARBITRUM_SEPOLIA_RPC_URL`, `X402_ARBITRUM_SEPOLIA_FACILITATOR_URL` |
| `solana-devnet`        | `X402_SOLANA_DEVNET_BUYER_SECRET_KEY`, `X402_SOLANA_DEVNET_MERCHANT_ADDRESS`                                                                                | `X402_SOLANA_DEVNET_RPC_URL`, `X402_SOLANA_DEVNET_FACILITATOR_URL`                                                                              |
| `near-testnet`         | `X402_NEAR_TESTNET_BUYER_ACCOUNT`, `X402_NEAR_TESTNET_BUYER_PRIVATE_KEY`, `X402_NEAR_TESTNET_MERCHANT_ACCOUNT`, and a relayer (below)                       | `X402_NEAR_TESTNET_RPC_URL`                                                                                                                     |
| `base`, `base-permit2` | `ALLOW_X402_MAINNET`, `X402_MAINNET_BUYER_PRIVATE_KEY`, `X402_MAINNET_MERCHANT_ADDRESS`, `X402_FACILITATOR_URL`                                             | `CDP_API_KEY_ID` with `CDP_API_KEY_SECRET`, or `X402_FACILITATOR_TOKEN`; `X402_MAINNET_RPC_URL`                                                 |
| `solana`               | `ALLOW_X402_MAINNET`, `X402_SOLANA_MAINNET_BUYER_SECRET_KEY`, `X402_SOLANA_MAINNET_MERCHANT_ADDRESS`, `X402_SOLANA_MAINNET_FACILITATOR_URL`                 | `X402_SOLANA_MAINNET_FACILITATOR_TOKEN`, `X402_SOLANA_MAINNET_RPC_URL`                                                                          |
| `near`                 | `ALLOW_X402_MAINNET`, `X402_NEAR_MAINNET_BUYER_ACCOUNT`, `X402_NEAR_MAINNET_BUYER_PRIVATE_KEY`, `X402_NEAR_MAINNET_MERCHANT_ACCOUNT`, and a relayer (below) | `X402_NEAR_MAINNET_RPC_URL`; `X402_NEAR_MAINNET_FACILITATOR_TOKEN` with an external facilitator                                                 |

A Solana secret key is the 64-byte key, as the JSON array `solana-keygen`
writes or the base58 string a wallet exports. A NEAR key is `ed25519:...`.

Without a facilitator URL, `near-testnet` and `near` run the SDK facilitator
on 127.0.0.1. Set `X402_NEAR_TESTNET_RELAYER_ACCOUNT` and
`X402_NEAR_TESTNET_RELAYER_PRIVATE_KEY`, or their `X402_NEAR_MAINNET_`
equivalents; the relayer pays gas in NEAR. Mainnet requires HTTPS, so the
suite uses the `openssl` CLI to create a certificate for the run.

`X402_NEAR_TESTNET_FACILITATOR_URL` or `X402_NEAR_MAINNET_FACILITATOR_URL`
replaces it with an external facilitator, whose `/supported` must name its
relayer accounts. FastNEAR's serves `near:mainnet` at
`https://x402.mikedotexe.com` and requires an API key, sent from
`X402_NEAR_MAINNET_FACILITATOR_TOKEN` as a bearer token.

The suite checks these prerequisites without performing them:

- **Permit2**: the buyer approves Permit2
  (`0x000000000022D473030F116dDEE9F6B43aC78BA3`) for the USDC once, which
  costs gas. The gateway never sends approvals.
- **Solana**: the merchant's USDC token account must exist; send it any amount
  once. The SDK client does not create it.
- **NEAR**: the merchant holds a storage deposit on the USDC token (NEP-145),
  which Circle's faucet makes when it sends USDC, and the buyer signs with a
  full-access key. An implicit account (64 hex characters) exists only once it
  has received NEAR, so a mainnet buyer needs a little.

## Spend

Each target pays `X402_SMOKE_AMOUNT` USDC once per run, `0.01` by default
(`X402_TESTNET_AMOUNT` and `X402_MAINNET_AMOUNT` are read when it is unset).
Before signing, the suite rejects payments above `1.00` on testnet or `0.10`
on mainnet, and totals above `X402_SMOKE_MAX_TOTAL` (the same defaults). The SDK client's default spend controls
also cap each payment at $1 in a default asset.

## What a run proves

For each target, in order:

1. On mainnet, the same config without `allowMainnet` is refused.
2. Discovery reports the deployment as testnet or mainnet on the target's
   network, without the facilitator's URL, and the provider's health check
   passes: chain, token and facilitator support.
3. The buyer holds enough USDC, and the target's preparation is in place.
4. The SDK client pays the challenge once; the gateway answers 200 with a
   successful `PAYMENT-RESPONSE` on the target's network.
5. The chain shows the transfer the settlement reported:
   - EVM: a successful receipt with the token's `Transfer` of the exact amount
     from the buyer to the payee.
   - Solana: a confirmed transaction without error whose token balances move
     the amount of the mint from the buyer to the payee.
   - NEAR: a final outer transaction carrying the buyer's `ft_transfer` of the
     amount to the payee, and the token's successful receipt for it.
6. Exactly one gateway receipt names the transaction, delivered with status 200.
7. The same payment presented again gets 402 or 409, and the backend is not
   called again.
8. Nothing the gateway logged contains a key or a credential.

Standalone balance changes cannot prove settlement; an unrelated transfer
could explain them. Each settled target prints `[testnet] evidence {...}`
or `[mainnet] evidence {...}` with target, network, method, asset, amount,
payer, payee, facilitator origin, transaction, explorer link, receipt id and
time, never keys. `X402_SMOKE_EVIDENCE_FILE` appends these records as JSON
lines.

Offline E2E tests exercise these evidence checks on Anvil, a Solana validator
and a NEAR sandbox; each check must reject an incorrect amount.

## Status

| Route                                                                                                    | Status                                                      |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| x402 on Base Sepolia and Base, EIP-3009 and Permit2; Solana devnet and mainnet; NEAR testnet and mainnet | settled; the transactions are in the [README](../README.md) |
| `arbitrum-sepolia`                                                                                       | smoke suite not yet run                                     |
| Other built-in mainnets                                                                                  | no smoke target                                             |
