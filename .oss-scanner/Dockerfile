# Build for Anthropic's OSS Scanner (anthropics/oss-scanner, projects/agent-commerce).
# The scanner builds this with the repository root as the build context.
# Dockerfile.dockerignore next to this file replaces the root .dockerignore,
# which would leave out contracts/lib. Network access exists only during this
# build, so every dependency the tests need is installed here.
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 \
    && rm -rf /var/lib/apt/lists/*

# Foundry, pinned to the version CI uses (FOUNDRY_VERSION in
# .github/workflows/ci.yml). The local-chain tests spawn a real Anvil and are
# skipped without it.
ARG FOUNDRY_VERSION=v1.7.1
RUN arch="$(dpkg --print-architecture)" \
    && base="https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_${arch}" \
    && curl -fsSL "${base}.tar.gz" -o /tmp/foundry.tar.gz \
    && curl -fsSL "${base}.sha256" -o /tmp/foundry.sha256 \
    && echo "$(cut -d' ' -f1 /tmp/foundry.sha256)  /tmp/foundry.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/foundry.tar.gz -C /usr/local/bin anvil forge cast \
    && rm /tmp/foundry.tar.gz /tmp/foundry.sha256 \
    && anvil --version

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

# All dependencies, dev included, then the build the package publishes.
RUN npm ci
RUN npm run build

# Unit, integration and conformance tests (no network needed). A failing test
# does not fail the image.
RUN npm test || echo "WARNING: npm test reported failures"
