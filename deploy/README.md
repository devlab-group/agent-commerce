# Deployment

Container image, testnet demo merchant and deployment templates for Agent Commerce Gateway (ACG). The gateway adds x402 payments to an existing HTTP API and exposes it over HTTP or MCP. It is self-hosted and non-custodial.

| Path            | Content                                                                               |
| --------------- | ------------------------------------------------------------------------------------- |
| `image/`        | Dockerfile and starter config for `ghcr.io/devlab-group/agent-commerce:<acg-version>` |
| `testnet-demo/` | Demo merchant: the image plus two paid resources on Base Sepolia, for local use       |
| `templates/`    | CapRover, Dokploy, Railway and Zeabur templates, laid out like their upstream repos   |
| `n8n/`          | n8n workflow template and test notes                                                  |
| `docs/`         | `deploy.md` (variable reference), one page per platform and n8n                       |

Start with [docs/deploy.md](docs/deploy.md). The development stack in the repository root (`docker compose up`: a local chain and the source in development mode) is separate from this image.

## Image

```sh
docker build -t ghcr.io/devlab-group/agent-commerce:2.7.2 deploy/image/
```

The image installs the published npm package at the version in `image/Dockerfile`, with pinned optional peers for x402 and MCP. Its starter configuration accepts testnets; mount your own configuration to use mainnet.

After publishing the npm package, the release workflow builds the image for amd64 and arm64 and pushes it to GHCR under the package version. Both architectures install dependencies from one lockfile generated during the build.

`image/check.sh` checks the starter configuration with networking disabled. CI checks an image built from the commit's `npm pack` tarball; the release workflow checks the amd64 image before pushing.

## Releasing a new version

The deployment templates and image pin the ACG version; the Dockerfile also pins optional peers. `tests/unit/deploy` checks these pins against `package.json`.

From the repository root, use Bash and GNU sed to update the ACG pins for a release. The substitutions target ACG pin formats and leave optional-peer versions unchanged, even if they match the old ACG version:

```sh
old=CURRENT_VERSION new=NEXT_VERSION
grep -rlF --exclude='*.png' "$old" deploy |
  xargs sed -i -E "s/(agent-commerce:|ACG_VERSION=|defaultValue: '|\"version\": \")${old//./\\.}([^0-9A-Za-z.+-]|$)/\1$new\2/g"
```

## Testnet demo

See [testnet-demo/README.md](testnet-demo/README.md).
