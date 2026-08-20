#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Gateway container entrypoint.
#
# Waits for the local chain deployment manifest, exports the addresses it
# contains, then starts the gateway. The manifest is the single source of truth
# for locally deployed addresses (docs/contracts.md) — nothing here hard-codes
# an address.
#
# Invoked as: bash docker/gateway-entrypoint.sh <command...>
# ---------------------------------------------------------------------------
set -euo pipefail

MANIFEST="${LOCAL_CHAIN_MANIFEST:-/workspace/.deploy/local.json}"
DEADLINE=$(( $(date +%s) + 120 ))

if [ "${X402_ENABLED:-true}" = "true" ]; then
  echo "[gateway] waiting for local chain manifest at ${MANIFEST}"
  while [ ! -f "${MANIFEST}" ]; do
    if [ "$(date +%s)" -gt "${DEADLINE}" ]; then
      echo "[gateway] FATAL: ${MANIFEST} never appeared." >&2
      echo "[gateway] chain-deploy must run first. Try: docker compose logs chain-deploy" >&2
      exit 1
    fi
    sleep 1
  done

  # Public values only. The facilitator signer is a local development key and
  # is labelled as such in the manifest.
  X402_ASSET="$(node -p "require('${MANIFEST}').asset")";                   export X402_ASSET
  X402_ASSET_NAME="$(node -p "require('${MANIFEST}').assetName")";          export X402_ASSET_NAME
  X402_ASSET_VERSION="$(node -p "require('${MANIFEST}').assetVersion")";    export X402_ASSET_VERSION
  X402_ASSET_DECIMALS="$(node -p "require('${MANIFEST}').assetDecimals")";  export X402_ASSET_DECIMALS
  MERCHANT_WALLET="${MERCHANT_WALLET:-$(node -p "require('${MANIFEST}').merchant.address")}"
  export MERCHANT_WALLET
  X402_FACILITATOR_PRIVATE_KEY="${X402_FACILITATOR_PRIVATE_KEY:-$(node -p "require('${MANIFEST}').facilitator.privateKey")}"
  export X402_FACILITATOR_PRIVATE_KEY

  echo "[gateway] asset            ${X402_ASSET}"
  echo "[gateway] settlement payTo ${MERCHANT_WALLET}"
  echo "[gateway] network          ${X402_NETWORK:-base-sepolia} via ${X402_RPC_URL:-unset}"
fi

exec "$@"
