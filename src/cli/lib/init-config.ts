/**
 * Pure YAML-rendering logic for `agent-commerce init`, kept separate from
 * prompt/IO concerns so it is trivially unit-testable.
 *
 * The on-disk shape here is the *raw* `config.yaml` document consumed
 * by `src/config`'s `parseConfig` (src/config/schema.ts):
 * `resources` is a map keyed by resource id, with `backend` / `expose` /
 * `payments` / `input` / `output` field names — distinct from the normalised
 * `CommerceResource` shape (`handler` / `exposedVia` / `paymentMethods` /
 * `inputSchema` / `outputSchema`) that `loadConfig()` returns.
 *
 * Addresses below are Anvil's well-known local dev accounts #0 (facilitator
 * signer) and #1 (merchant `payTo`) — public, fixed, printed by every
 * `anvil` startup banner. Never fund them.
 * Imported from `src/payments/x402/testing.ts` — the
 * canonical source (docs/contracts.md) — rather than duplicated as literals,
 * so `init` can never drift from `scripts/chain/deploy.ts`'s account layout.
 * A hand-copied or truncated literal here breaks every paid request and
 * silently defeats the dev-key guard. The MockUSDC `asset` address is a clearly labelled placeholder: it
 * cannot be known before `npm run chain:deploy` writes `.deploy/local.json`, so
 * it must not be the zero address (rejected by config validation) and must
 * be replaced by the real deployed address.
 */

import { stringify } from 'yaml';
// Narrow module, not the `testing.js` barrel — see manifest-env.ts for why.
import { ANVIL_WELL_KNOWN_ACCOUNTS } from '../../payments/x402/local-chain/accounts.js';

/** Anvil account #1 — merchant settlement destination, never the gateway/facilitator. */
export const LOCAL_DEV_MERCHANT_ADDRESS = ANVIL_WELL_KNOWN_ACCOUNTS[1].address;
/** Anvil account #0 — local facilitator signer (broadcasts settlement on the dev chain only). */
export const LOCAL_DEV_FACILITATOR_PRIVATE_KEY = ANVIL_WELL_KNOWN_ACCOUNTS[0].privateKey;
/** Placeholder only — replace with the MockUSDC address from `.deploy/local.json`. */
export const PLACEHOLDER_ASSET_ADDRESS = '0x000000000000000000000000000000000000dEaD';

export type InitResourceChoice = 'weather' | 'report';
export type InitProtocolChoice = 'http' | 'mcp';

export interface InitAnswers {
  readonly backendBaseUrl: string;
  readonly resources: readonly InitResourceChoice[];
  readonly protocols: readonly InitProtocolChoice[];
  readonly x402Enabled: boolean;
  readonly merchantPayTo: string;
}

export function defaultInitAnswers(): InitAnswers {
  return {
    backendBaseUrl: 'http://localhost:3000',
    resources: ['weather', 'report'],
    protocols: ['http', 'mcp'],
    x402Enabled: true,
    merchantPayTo: LOCAL_DEV_MERCHANT_ADDRESS,
  };
}

function buildResourcesMap(answers: InitAnswers): Record<string, unknown> {
  const resources: Record<string, unknown> = {};
  const expose = [...answers.protocols];

  if (answers.resources.includes('weather')) {
    resources.weather = {
      name: 'Get weather',
      description: 'Deterministic demo weather lookup (free resource).',
      input: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
        additionalProperties: false,
      },
      backend: {
        type: 'http',
        method: 'GET',
        url: `${answers.backendBaseUrl}/api/weather/{city}`,
      },
      pricing: { type: 'free' },
      expose,
    };
  }

  if (answers.resources.includes('report')) {
    const paid = answers.x402Enabled;
    resources.report = {
      name: 'Get market report',
      description: 'Deterministic demo premium market report.',
      // No caller-supplied fields for this resource: an explicit empty,
      // closed schema (rather than omitting `input`) so a missing schema can
      // never be read as "anything goes".
      input: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      backend: {
        type: 'http',
        method: 'GET',
        url: `${answers.backendBaseUrl}/api/report`,
      },
      pricing: paid ? { type: 'fixed', amount: '0.01', currency: 'USDC' } : { type: 'free' },
      expose,
      ...(paid ? { payments: ['x402'] } : {}),
    };
  }

  return resources;
}

/** Builds the raw config object accepted by `parseConfig` (src/config). */
export function buildInitConfigObject(answers: InitAnswers): Record<string, unknown> {
  return {
    version: 1,
    merchant: {
      id: 'demo-merchant',
      name: 'Demo Merchant',
      publicBaseUrl: 'http://localhost:8080',
    },
    server: { port: 8080, host: '127.0.0.1' },
    storage: { receipts: { driver: 'sqlite', path: './data/receipts.db' } },
    protocols: {
      http: { enabled: answers.protocols.includes('http') },
      mcp: { enabled: answers.protocols.includes('mcp'), mountPath: '/mcp' },
    },
    resources: buildResourcesMap(answers),
    payments: answers.x402Enabled
      ? {
          x402: {
            enabled: true,
            network: 'base-sepolia',
            rpcUrl: 'http://127.0.0.1:8545',
            asset: PLACEHOLDER_ASSET_ADDRESS,
            assetName: 'MockUSDC',
            assetVersion: '2',
            assetDecimals: 6,
            payTo: answers.merchantPayTo,
            maxTimeoutSeconds: 60,
            facilitator: { mode: 'local', signerPrivateKey: LOCAL_DEV_FACILITATOR_PRIVATE_KEY },
          },
        }
      : {},
  };
}

const HEADER = `# Generated by \`agent-commerce init\`.
#
# Any address/key below labelled "LOCAL DEVELOPMENT ONLY" or "placeholder" is
# either one of Anvil's well-known, public dev accounts (never fund them,
# never use them outside a local chain) or a
# not-yet-real address. Before running against the local chain, run
# \`npm run chain:deploy\` and replace \`payments.x402.asset\` with the deployed
# MockUSDC address from \`.deploy/local.json\`. Replace \`payments.x402.payTo\`
# with your real merchant-controlled settlement address before ever pointing
# this at a funded network.
#
# server.host is loopback (127.0.0.1) on purpose: binding every interface
# should be a deliberate edit, not something you inherit from a generator.
#
# server.adminToken / server.allowedOrigins are left unset here — a generated
# secret in a file you might commit is its own problem, so this is left as a
# placeholder for you to fill in rather than a real token. Without a token,
# the operator routes (/api/receipts, /api/events, /api/events/stream) —
# the merchant's commerce ledger: payer addresses, amounts, settlement
# hashes — return 404 rather than serving openly. To enable them, uncomment
# and set:
#   server:
#     adminToken: \${ADMIN_TOKEN}
#     allowedOrigins:
#       - http://localhost:5173
# See SECURITY.md before exposing this gateway beyond localhost.
`;

export function renderInitConfigYaml(answers: InitAnswers): string {
  const body = stringify(buildInitConfigObject(answers), { indent: 2 });
  return `${HEADER}\n${body}`;
}
