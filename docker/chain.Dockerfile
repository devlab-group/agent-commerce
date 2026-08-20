# ---------------------------------------------------------------------------
# Deterministic local EVM: Anvil pinned to chain id 84532 so that x402's
# `base-sepolia` network id matches.
#
# This is a private, disposable chain. It is NOT Base Sepolia and it holds no
# real value. Its accounts are Anvil's well-known development keys:
# LOCAL DEVELOPMENT ONLY - DO NOT FUND.
# ---------------------------------------------------------------------------
# Pinned by digest, not `:latest`: a mutable base image is a
# mutable input to a chain this project calls deterministic, and it is what
# compiles MockUSDC. This digest is forge 1.7.1, the same release CI pins via
# FOUNDRY_VERSION. Repoint both together.
FROM ghcr.io/foundry-rs/foundry@sha256:8347b728d5d393dac1c018691b36f506d23b9dcd78341d40ea0fcb11c3a19cdd

EXPOSE 8545

# `--network ethereum` is required, not cosmetic: chain id 84532 is Base
# Sepolia's, which anvil otherwise infers as the `optimism` network family —
# and that family is compiled out of this image, so it refuses to start. We
# only need plain EVM execution plus a chain that *reports* 84532, so that the
# EIP-712 domain MockUSDC derives from `block.chainid` matches the one x402
# computes from the network name.
ENTRYPOINT ["anvil"]
CMD ["--host", "0.0.0.0", "--port", "8545", "--chain-id", "84532", "--network", "ethereum", "--accounts", "10", "--balance", "10000", "--silent"]
