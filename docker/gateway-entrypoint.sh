#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Gateway container entrypoint.
#
# Wait for the local chain manifest, export its deployment values, then run
# the command. Deployed addresses come from the manifest (docs/contracts.md).
#
# Invoked as: bash docker/gateway-entrypoint.sh <command...>
# LOCAL_CHAIN_MANIFEST_WAIT_SECONDS (default 120) bounds the wait for the manifest.
# ---------------------------------------------------------------------------
set -euo pipefail

MANIFEST="${LOCAL_CHAIN_MANIFEST:-/workspace/.deploy/local.json}"
DEADLINE=$(( $(date +%s) + ${LOCAL_CHAIN_MANIFEST_WAIT_SECONDS:-120} ))

echo "[gateway] waiting for local chain manifest at ${MANIFEST}"
while [ ! -f "${MANIFEST}" ]; do
  if [ "$(date +%s)" -gt "${DEADLINE}" ]; then
    echo "[gateway] FATAL: ${MANIFEST} never appeared." >&2
    echo "[gateway] chain-deploy must run first. Try: docker compose logs chain-deploy" >&2
    exit 1
  fi
  sleep 1
done

# Every manifest value is public, including the facilitator key: one of Anvil's
# well-known development keys, labeled as such in the manifest. One node
# process prints one value per line; a failure stops the script under `set -e`.
values="$(node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const fields = [m.asset, m.assetName, m.assetVersion, m.assetDecimals,
    m.merchant.address, m.facilitator.privateKey];
  console.log(fields.map(String).join("\n"));
' "${MANIFEST}")"
mapfile -t v <<< "${values}"

export X402_ASSET="${v[0]}"
export X402_ASSET_NAME="${v[1]}"
export X402_ASSET_VERSION="${v[2]}"
export X402_ASSET_DECIMALS="${v[3]}"
export MERCHANT_WALLET="${MERCHANT_WALLET:-${v[4]}}"
export X402_FACILITATOR_PRIVATE_KEY="${X402_FACILITATOR_PRIVATE_KEY:-${v[5]}}"

echo "[gateway] asset            ${X402_ASSET}"
echo "[gateway] settlement payTo ${MERCHANT_WALLET}"
echo "[gateway] network          ${X402_NETWORK:-eip155:84532} via ${X402_RPC_URL:-unset}"

exec "$@"
