# ---------------------------------------------------------------------------
# Deterministic local EVM: Anvil on chain id 84532, matching the demo
# network `eip155:84532`.
#
# This is a private, disposable chain. It is NOT Base Sepolia and it holds no
# real value. Its accounts are Anvil's well-known development keys:
# LOCAL DEVELOPMENT ONLY - DO NOT FUND.
# ---------------------------------------------------------------------------
# Pinned by digest, not `:latest`: a mutable image would make the deterministic
# chain depend on whatever was published last. This digest is Foundry 1.7.1,
# the release ci.yml and release.yml pin as FOUNDRY_VERSION. Move all three
# together.
FROM ghcr.io/foundry-rs/foundry@sha256:8347b728d5d393dac1c018691b36f506d23b9dcd78341d40ea0fcb11c3a19cdd

EXPOSE 8545

# `--network ethereum` is required: anvil otherwise infers the `optimism`
# network family from Base Sepolia's chain id 84532, and this image is built
# without that family, so anvil refuses to start. Plain EVM execution is
# enough; what matters is that the chain reports 84532, so the EIP-712 domain
# MockUSDC builds from `block.chainid` matches the chain id x402 derives from
# `eip155:84532`.
ENTRYPOINT ["anvil"]
CMD ["--host", "0.0.0.0", "--port", "8545", "--chain-id", "84532", "--network", "ethereum", "--accounts", "10", "--balance", "10000", "--silent"]
