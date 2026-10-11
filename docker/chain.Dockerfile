# ---------------------------------------------------------------------------
# Deterministic local EVM: Anvil on chain id 31337, its default, matching the
# demo network `eip155:31337`.
#
# This is a private, disposable chain that holds no real value. Its accounts are Anvil's well-known development keys:
# LOCAL DEVELOPMENT ONLY - DO NOT FUND.
# ---------------------------------------------------------------------------
# Pinned by digest, not `:latest`: a mutable image would make the deterministic
# chain depend on whatever was published last. This digest is Foundry 1.7.1,
# the release ci.yml and release.yml pin as FOUNDRY_VERSION. Move all three
# together.
FROM ghcr.io/foundry-rs/foundry@sha256:8347b728d5d393dac1c018691b36f506d23b9dcd78341d40ea0fcb11c3a19cdd

EXPOSE 8545

# The chain id must be 31337: MockUSDC builds its EIP-712 domain from
# `block.chainid`, and x402 derives the domain's chain id from `eip155:31337`.
ENTRYPOINT ["anvil"]
CMD ["--host", "0.0.0.0", "--port", "8545", "--chain-id", "31337", "--accounts", "10", "--balance", "10000", "--silent"]
