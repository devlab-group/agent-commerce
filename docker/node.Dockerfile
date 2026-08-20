# ---------------------------------------------------------------------------
# Shared Node image for every TypeScript service in the demo stack.
#
# v0.1.0-alpha runs from TypeScript source via tsx, so there is no per-service
# build output to copy around. One image,
# different commands.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim

ENV NODE_ENV=development

WORKDIR /workspace

# Everything below runs as the unprivileged `node` user the
# base image already ships. Switching *before* the install (rather than
# chowning afterwards) is what makes it cheap: node_modules, the vite cache and
# the data directories are created owned by the user that will write them at
# runtime, with no extra 700 MB layer. `/workspace/data` matters especially —
# Docker seeds a named volume from the image directory, ownership included, so
# a root-owned one would leave the gateway unable to write receipts.
RUN chown node:node /workspace
USER node

# Manifest first so dependency installation caches independently of source.
# One package, one manifest — the single-package refactor removed the workspace
# and with it the ten sibling manifests this block used to enumerate.
COPY --chown=node:node package.json package-lock.json ./

# --ignore-scripts is deliberate and load-bearing.
#
# better-sqlite3@13 ships its binaries *inside* the npm tarball
# (`prebuilds/linux-x64.node`) and declares no install script — so there is
# nothing to run and nothing to download. But npm treats any package carrying a
# `binding.gyp` with no install script as "build me", and runs `node-gyp
# rebuild` by default. That needs Python and a C++ toolchain this slim image
# does not carry, and it failed the build outright. (It does not reproduce on a
# developer machine with a toolchain and a newer npm — only here, which is
# exactly why the assertions below exist.)
#
# esbuild is the one package that genuinely needs a binary. It ships it as the
# @esbuild/linux-x64 optional dependency, which npm installs without running
# any script, so tsx still works.
#
# Both assumptions are asserted immediately, so the build fails loudly here
# rather than shipping an image that dies on first request.
RUN npm ci --ignore-scripts \
  && npx tsx --version \
  && node -e "const D=require('better-sqlite3'); const d=new D(':memory:'); d.exec('create table t(a)'); console.log('better-sqlite3 ok (shipped prebuild, no toolchain needed)'); d.close();"

COPY --chown=node:node . .

RUN mkdir -p /workspace/data /workspace/.deploy

EXPOSE 3000 8080 5173
CMD ["node", "--version"]
