# ---------------------------------------------------------------------------
# Shared Node image for every TypeScript service in the demo stack. The stack
# runs from TypeScript source through tsx, so there is no build output to copy:
# one image, different commands.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim

ENV NODE_ENV=development

WORKDIR /workspace

# Everything below runs as the base image's unprivileged `node` user. Switching
# before the install, rather than chowning afterwards, creates node_modules,
# the vite cache and the data directories owned by their runtime writer without
# an extra 700 MB layer. `/workspace/data` matters most: Docker seeds a new
# named volume from it, ownership included, and the gateway writes receipts
# there.
RUN chown node:node /workspace
USER node

# Manifest first, so the dependency install caches independently of source
COPY --chown=node:node package.json package-lock.json ./

# --ignore-scripts skips every dependency install script, such as the
# postinstall steps of @coinbase/x402 and esbuild. None is needed here:
# - better-sqlite3@13 ships its binaries in the tarball (`prebuilds/`) and sets
#   `"gypfile": false`, so npm does not add its implicit `node-gyp rebuild`,
#   which would need a toolchain this slim image lacks.
# - esbuild, which tsx needs, gets its binary from the @esbuild/linux-x64
#   optional dependency, which installs without a script.
#
# The RUN below checks both, so a broken install fails the build instead of the
# first request.
RUN npm ci --ignore-scripts \
  && npx tsx --version \
  && node -e "const D=require('better-sqlite3'); const d=new D(':memory:'); d.exec('create table t(a)'); console.log('better-sqlite3 ok (shipped prebuild, no toolchain needed)'); d.close();"

COPY --chown=node:node . .

RUN mkdir -p /workspace/data /workspace/.deploy

EXPOSE 3000 8080 5173
CMD ["node", "--version"]
