# Contributing

Thanks for looking at Agent Commerce Gateway. The architecture is deliberate and
the scope is deliberately narrow; both of those are load-bearing, and most of
the rules below exist to keep them that way.

## Ground rules

1. **Scope discipline is a release requirement.** Supported today: MCP, HTTP and
   x402. Experimental and off by default: A2A, ACP, AP2 and OpenAPI import. New
   protocols and rails land after the adapter model survives real use. Classify
   every proposal as `BLOCKER` / `QUALITY` / `NICE-TO-HAVE` / `POST-1.0` - the
   default answer to a new capability is `POST-1.0`.
2. **Never make the gateway custodial.** No PR may introduce storage of a
   merchant or buyer private key, seed phrase or fund custody. See
   [`SECURITY.md`](SECURITY.md).
3. **Paid resources fail closed.** No PR may add a path that delivers a paid
   resource without a successful verify + replay reservation + settle.
4. **Canonical model first.** Protocol- or chain-specific types must not appear
   in `src/core`. Map at adapter boundaries.
5. **Tests ship with implementation.** Code without a happy path *and* a
   negative path is not a complete change.
6. **Alpha honesty.** Partial support is labelled `experimental` / `partial` /
   `planned`. Never widen a compatibility claim without the test to back it.

## Getting set up

```bash
git clone <repo> && cd agent-commerce
npm install
docker compose up -d # Anvil + MockUSDC + merchant API + gateway + dashboard
npm run agent-commerce -- doctor --config config-demo.yaml
npm run demo:agent
```

Requirements: Node >= 22, npm 10, Docker, and [Foundry](https://getfoundry.sh)
(`anvil`, `forge`, `cast`) for the chain work. On Linux, if your user is not
UID/GID 1000, see the note in the [README](README.md#quickstart) before
`docker compose up`.

## The loop

```bash
npm run verify # contract + lint + typecheck + test - run this before opening a PR
npm run test:e2e # deterministic end-to-end (boots its own chain)
npm run lint:fix
```

Scope a run to one area with `npx vitest run tests/unit/<area>`.

A change is not mergeable if the contract surface changed unannounced,
TypeScript fails, lint fails, required tests fail, or the deterministic E2E
fails.

## Architecture you need to know before writing code

Read, in order:

1. [`docs/architecture.md`](docs/architecture.md) - the shape of the system.
2. [`docs/contracts.md`](docs/contracts.md) - the frozen cross-package contract.

The one rule that surprises people: **every protocol adapter converges on
`ExecutionPipeline.execute`**. An adapter never calls a merchant backend and
never implements payment logic.

## Adding a protocol adapter

See [`docs/contributing-adapters.md`](docs/contributing-adapters.md). Checklist:

- [ ] schema mapping from `CommerceResource`
- [ ] request normalisation into `CanonicalRequest`
- [ ] deterministic mapping of `CommerceError` and `PaymentRequiredEnvelope`
- [ ] an honest `AdapterDescriptor` (`supportedSpec`, `capabilities`,
      `unsupported`, `status`)
- [ ] conformance fixtures pinning the spec revision
- [ ] contract tests driven through a real client of that protocol
- [ ] documentation and a support-matrix row

## Adding a payment rail

Implement `PaymentProvider`. Required before review:

- [ ] `verify` has no fund-moving side effects
- [ ] a `replayKey` derived only from the payment authorisation
- [ ] negative tests: no payment, malformed, wrong amount, wrong recipient,
      wrong network, wrong asset, replay, provider unavailable
- [ ] a deterministic settlement proof - real state change, not a mocked success
- [ ] no private key held by the gateway

## Adding an authorization method

Implement `AuthorizationProvider`. Authorization gates settlement; it never
moves money and never unlocks a resource on its own. Required before review:

- [ ] verification and reservation are one atomic step, before settlement
- [ ] a replay identity that survives re-presentation of the same proof
- [ ] binding to the resolved resource, input and price, not just to a signature
- [ ] `consume` / `release` / `markUncertain` finalizers, with release reserved
      for failures that provably moved no money
- [ ] static trust only: no key discovery, no outbound request from a proof
- [ ] `AUTHORIZATION_*` error codes, never a payment code, and a coarse
      rejection reason that is not an oracle for trust policy
- [ ] nothing of the proof itself in a receipt, an event or a log

AP2 is the worked example: [`docs/ap2.md`](docs/ap2.md).

## Publishing

The repository *is* the package: one `package.json`, published as
**`@devlab.group/agent-commerce`**. It ships the `agent-commerce` binary and four
library paths - `.`, `./ap2`, `./mcp`, `./x402` - built from `src/` into
`dist/`.

Two constraints a PR must not break. **The heavy rails are optional peer
dependencies** (`@modelcontextprotocol/sdk`, `@x402/core`, `@x402/evm`, `viem`,
`jose`, `@sd-jwt/core`, `canonicalize`, `@coinbase/x402`), and neither the main
entry nor the CLI may import one, or a default install breaks. **Architectural
boundaries live in directories under `src/`**, not in package manifests, so a
reappearing `pnpm-workspace.yaml` or `packages/` directory means two models are
being run at once. The packaging tests fail on either.

```bash
npm run build # bundle -> dist/index.js + dist/cli/index.js
npm run test:cli:dist # run the built binary under plain node
npm run pack:dry # inspect what would be published
```

Only `dist/`, `README.md` and `LICENSE` are published. Everything else -
`src/`, `tests/`, `demo/`, `scripts/`, `docs/` - stays in the repository. Note
that `dist/` ships sourcemaps that embed the TypeScript they were built from;
that is intended (public source, real stack traces), not an oversight.

Never run `npm publish` without explicit maintainer approval.

## Commits and PRs

Conventional commits: `type(scope): subject`, lower case, no trailing full stop.
Types in use are `feat`, `fix`, `docs`, `test`, `chore` and `refactor`; the
scope is the area you touched (`core`, `config`, `pipeline`, `gateway`,
`runtime`, `ap2`, `acp`, `openapi`, `cli`, `payment`), and repo-wide changes
drop it. Keep commits small and coherent.

```text
feat(pipeline): enforce authorization before payment settlement
test(acp): add stable checkout conformance coverage
```

A PR should say what changed, why, how you tested it, and what it does **not**
cover.

## Reporting bugs

Include the version or commit, your `agent-commerce doctor --json` output (it
contains no secrets), what you expected, and what happened. For security issues,
follow [`SECURITY.md`](SECURITY.md) instead - do not open a public issue.

## Code of conduct

Be straightforward and civil. Assume good faith, disagree with the argument
rather than the person, and keep reviews about the code.

## Licence

By contributing you agree that your contributions are licensed under the
Apache License 2.0.
