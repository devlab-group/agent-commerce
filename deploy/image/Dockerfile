# Agent Commerce Gateway image with the published npm package and pinned
# optional x402 and MCP peers. The release workflow publishes it as
# ghcr.io/devlab-group/agent-commerce:<ACG_VERSION>
#
#   docker build -t ghcr.io/devlab-group/agent-commerce:2.7.2 deploy/image/
#
# tests/unit/deploy checks ACG_VERSION and the peer versions against
# package.json, because npm does not enforce optional peers.
#
# CI installs the commit's `npm pack` tarball in place of the registry package:
#
#   docker build --build-context pkg=<directory with the tarball> \
#     --build-arg ACG_PACKAGE=/tmp/pkg/<tarball> deploy/image/
#
# Without --build-context the `pkg` stage is empty
ARG ACG_VERSION=2.7.2
ARG NODE_IMAGE=node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

FROM scratch AS pkg

# Resolve dependencies once on the build platform; each target image installs
# from the same generated lockfile
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS lock
ARG ACG_VERSION
ARG ACG_PACKAGE=@devlab.group/agent-commerce@${ACG_VERSION}
WORKDIR /app
RUN --mount=type=bind,from=pkg,target=/tmp/pkg \
    npm install --package-lock-only --no-audit --no-fund --save-exact \
      "${ACG_PACKAGE}" \
      @x402/core@2.30.0 \
      @x402/evm@2.30.0 \
      viem@2.57.1 \
      @modelcontextprotocol/server@2.3.0

FROM ${NODE_IMAGE}
WORKDIR /app
COPY --from=lock /app/package.json /app/package-lock.json ./

# Install as root so the gateway's node user cannot change packages or config.
# --ignore-scripts skips install scripts; better-sqlite3 13 provides prebuilt
# binaries for glibc Linux on x64 and arm64. The binding check fails the build
# if the native module cannot load.
#
# /app/data stores SQLite receipts and is the only directory under /app given
# to node during the build. Mount a volume there; a new named volume inherits
# its contents and remains writable by node.
RUN --mount=type=bind,from=pkg,target=/tmp/pkg \
    npm ci --ignore-scripts --no-audit --no-fund \
 && node -e "const D=require('better-sqlite3');const d=new D(':memory:');d.exec('create table t(a)');d.close()" \
 && npm cache clean --force \
 && mkdir /app/data && chown node:node /app/data

COPY config.yaml /app/config.yaml
USER node

ENV NODE_ENV=production \
    AGENT_COMMERCE_CONFIG=/app/config.yaml

EXPOSE 8080

# Probe liveness; /ready also checks the facilitator and RPC. An outage
# there should not make platforms restart a gateway that can still serve.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/app/node_modules/.bin/agent-commerce"]
CMD ["start"]
