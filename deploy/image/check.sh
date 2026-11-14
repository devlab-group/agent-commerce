#!/usr/bin/env bash
# Check the starter configuration in a gateway image with networking disabled.
# CI uses the commit's tarball image; the release workflow checks the amd64
# image before pushing.
#
#   bash deploy/image/check.sh <image>
#
# With networking disabled, the facilitator and RPC are unreachable.
# x402 must be the only readiness check that does not pass; an unpaid
# invocation must still receive a 402 offer.
set -euo pipefail

name=acg-check
docker run -d --name "$name" --network none \
  -e MERCHANT_WALLET=0x1111111111111111111111111111111111111111 \
  -e MERCHANT_API_URL=http://127.0.0.1:9/ \
  -e ADMIN_TOKEN=check-admin-token \
  "$1" > /dev/null
trap 'code=$?; [ "$code" -eq 0 ] || docker logs "$name"; docker rm -f "$name" > /dev/null' EXIT

test "$(docker exec "$name" id -u)" = 1000

docker exec -i "$name" node --input-type=module - <<'EOF'
const base = 'http://127.0.0.1:8080';
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
for (let i = 0; i < 30; i++) {
  if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const ready = await (await fetch(`${base}/ready`)).json();
const checks = [ready.store, ...ready.adapters, ...ready.paymentProviders, ...ready.authorizationProviders];
const failing = checks.filter((c) => c.status !== 'pass').map((c) => c.name);
if (failing.join() !== 'x402') fail(`unexpected readiness: ${JSON.stringify(ready)}`);
const r = await fetch(`${base}/api/resources/paid_api/invoke`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
});
if (r.status !== 402) fail(`invoke -> ${r.status}`);
const [offer] = JSON.parse(Buffer.from(r.headers.get('payment-required'), 'base64').toString()).accepts;
const want = {
  scheme: 'exact',
  network: 'eip155:84532',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  amount: '10000',
  payTo: process.env.MERCHANT_WALLET,
};
for (const [key, value] of Object.entries(want)) {
  if (offer[key] !== value) fail(`${key}: ${offer[key]}`);
}
EOF

# The image's HEALTHCHECK must also pass without networking
for _ in $(seq 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$name")" = healthy ] && break
  sleep 1
done
test "$(docker inspect -f '{{.State.Health.Status}}' "$name")" = healthy
echo "image ok: the starter configuration served a 402 offline"
