/**
 * Public-network smoke targets: one per network, family and transfer method.
 * Reads settings and selects targets without network calls, enabling offline tests.
 *
 * Targets pay the network's default USDC; buyer and merchant keys stay outside
 * the gateway. Some targets share accounts.
 */
import { parseCanonicalAmount } from '../../../../src/payments/x402/amount';
import type { X402FacilitatorConfig } from '../../../../src/payments/x402/guardrails';

export type SmokeKind = 'testnet' | 'mainnet';
export type SmokeFamily = 'evm' | 'svm' | 'near';
type Env = Readonly<Record<string, string | undefined>>;
type FacilitatorAuth = Extract<X402FacilitatorConfig, { mode: 'remote' }>['auth'];

/** How the gateway reaches the facilitator that settles a target */
export type SmokeFacilitator =
  | { readonly type: 'remote'; readonly url: string; readonly auth: FacilitatorAuth }
  // Run the SDK facilitator locally with a gas-paying NEAR relayer.
  | {
      readonly type: 'self-hosted-near';
      readonly relayerAccount: string;
      readonly relayerKey: string;
    };

export interface SmokeSettings {
  readonly rpcUrl: string;
  readonly payTo: string;
  /** EVM private key, Solana secret key, or NEAR `ed25519:` key of `account` */
  readonly buyerKey: string;
  readonly buyerAccount?: string;
  readonly facilitator: SmokeFacilitator;
  /** Decimal USDC charged once per run */
  readonly amount: string;
  /** Values that must never appear in anything the gateway logs */
  readonly secrets: readonly string[];
}

export interface SmokeTarget {
  readonly id: string;
  readonly kind: SmokeKind;
  readonly family: SmokeFamily;
  readonly network: string;
  readonly assetTransferMethod?: 'permit2';
  /**
   * Runs only when named in `X402_SMOKE_TARGETS`: it reuses another target's
   * buyer, which needs more preparation than that target's funds
   */
  readonly onlyWhenNamed?: true;
  /** A transaction's page on a public explorer */
  readonly explorer: (reference: string) => string;
  readonly resolve: (env: Env) => {
    readonly missing: readonly string[];
    readonly settings?: SmokeSettings;
  };
}

const read = (env: Env, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
};

// A target's variables: required ones it names when absent, optional ones with defaults
function resolver(spec: {
  readonly required: readonly string[];
  readonly settings: (value: (name: string) => string, env: Env) => SmokeSettings;
}): SmokeTarget['resolve'] {
  return (env) => {
    const missing = spec.required.filter((name) => read(env, name) === undefined);
    if (missing.length > 0) return { missing };
    return { missing, settings: spec.settings((name) => read(env, name) as string, env) };
  };
}

const amountFor = (env: Env, kind: SmokeKind): string =>
  read(env, 'X402_SMOKE_AMOUNT') ??
  read(env, kind === 'testnet' ? 'X402_TESTNET_AMOUNT' : 'X402_MAINNET_AMOUNT') ??
  '0.01';

const remote = (url: string, auth: FacilitatorAuth = { type: 'none' }): SmokeFacilitator => ({
  type: 'remote',
  url,
  auth,
});

// EVM testnets share one buyer key and merchant address: an EVM key signs on any chain
function evmTestnet(options: {
  readonly id: string;
  readonly network: string;
  readonly rpcVariable: string;
  readonly defaultRpc: string;
  readonly facilitatorVariable: string;
  readonly defaultFacilitator: string;
  readonly explorer: string;
  readonly assetTransferMethod?: 'permit2';
  readonly onlyWhenNamed?: true;
}): SmokeTarget {
  return {
    id: options.id,
    kind: 'testnet',
    family: 'evm',
    network: options.network,
    ...(options.assetTransferMethod ? { assetTransferMethod: options.assetTransferMethod } : {}),
    ...(options.onlyWhenNamed ? { onlyWhenNamed: true } : {}),
    explorer: (tx) => `${options.explorer}/tx/${tx}`,
    resolve: resolver({
      required: ['X402_TESTNET_BUYER_PRIVATE_KEY', 'X402_TESTNET_MERCHANT_ADDRESS'],
      settings: (value, env) => ({
        rpcUrl: read(env, options.rpcVariable) ?? options.defaultRpc,
        payTo: value('X402_TESTNET_MERCHANT_ADDRESS'),
        buyerKey: value('X402_TESTNET_BUYER_PRIVATE_KEY'),
        facilitator: remote(read(env, options.facilitatorVariable) ?? options.defaultFacilitator),
        amount: amountFor(env, 'testnet'),
        secrets: [value('X402_TESTNET_BUYER_PRIVATE_KEY')],
      }),
    }),
  };
}

const SOLANA_EXPLORER = 'https://explorer.solana.com/tx';

// A mainnet facilitator credential: CDP, a bearer token, or none
function mainnetAuth(env: Env, tokenVariable: string): FacilitatorAuth {
  const id = read(env, 'CDP_API_KEY_ID');
  const secret = read(env, 'CDP_API_KEY_SECRET');
  if (tokenVariable === 'X402_FACILITATOR_TOKEN' && id && secret) {
    return { type: 'cdp', apiKeyId: id, apiKeySecret: secret };
  }
  const token = read(env, tokenVariable);
  return token ? { type: 'bearer', token } : { type: 'none' };
}

function authSecrets(auth: FacilitatorAuth): string[] {
  if (auth.type === 'bearer') return [auth.token];
  if (auth.type === 'cdp') return [auth.apiKeySecret];
  return [];
}

// Base mainnet targets share one buyer, merchant and facilitator
function baseMainnet(id: string, assetTransferMethod?: 'permit2'): SmokeTarget {
  return {
    id,
    kind: 'mainnet',
    family: 'evm',
    network: 'eip155:8453',
    ...(assetTransferMethod ? { assetTransferMethod } : {}),
    explorer: (tx) => `https://basescan.org/tx/${tx}`,
    resolve: resolver({
      required: [
        'ALLOW_X402_MAINNET',
        'X402_MAINNET_BUYER_PRIVATE_KEY',
        'X402_MAINNET_MERCHANT_ADDRESS',
        'X402_FACILITATOR_URL',
      ],
      settings: (value, env) => {
        const auth = mainnetAuth(env, 'X402_FACILITATOR_TOKEN');
        return {
          // A dedicated endpoint avoids rate limits that make a settled payment read as failed
          rpcUrl: read(env, 'X402_MAINNET_RPC_URL') ?? 'https://base.drpc.org',
          payTo: value('X402_MAINNET_MERCHANT_ADDRESS'),
          buyerKey: value('X402_MAINNET_BUYER_PRIVATE_KEY'),
          facilitator: remote(value('X402_FACILITATOR_URL'), auth),
          amount: amountFor(env, 'mainnet'),
          secrets: [value('X402_MAINNET_BUYER_PRIVATE_KEY'), ...authSecrets(auth)],
        };
      },
    }),
  };
}

// Without a facilitator URL, the harness runs the SDK's facilitator with this
// relayer
function nearTarget(kind: SmokeKind): SmokeTarget {
  const name = (field: string) => `X402_NEAR_${kind.toUpperCase()}_${field}`;
  return {
    id: kind === 'testnet' ? 'near-testnet' : 'near',
    kind,
    family: 'near',
    network: `near:${kind}`,
    explorer: (tx) => `https://${kind === 'testnet' ? 'testnet.' : ''}nearblocks.io/txns/${tx}`,
    resolve: (env) => {
      const url = read(env, name('FACILITATOR_URL'));
      const auth: FacilitatorAuth =
        kind === 'mainnet' ? mainnetAuth(env, name('FACILITATOR_TOKEN')) : { type: 'none' };
      return resolver({
        required: [
          ...(kind === 'mainnet' ? ['ALLOW_X402_MAINNET'] : []),
          name('BUYER_ACCOUNT'),
          name('BUYER_PRIVATE_KEY'),
          name('MERCHANT_ACCOUNT'),
          ...(url === undefined ? [name('RELAYER_ACCOUNT'), name('RELAYER_PRIVATE_KEY')] : []),
        ],
        settings: (value) => ({
          rpcUrl: read(env, name('RPC_URL')) ?? `https://rpc.${kind}.fastnear.com`,
          payTo: value(name('MERCHANT_ACCOUNT')),
          buyerKey: value(name('BUYER_PRIVATE_KEY')),
          buyerAccount: value(name('BUYER_ACCOUNT')),
          facilitator:
            url !== undefined
              ? remote(url, auth)
              : {
                  type: 'self-hosted-near',
                  relayerAccount: value(name('RELAYER_ACCOUNT')),
                  relayerKey: value(name('RELAYER_PRIVATE_KEY')),
                },
          amount: amountFor(env, kind),
          secrets: [
            value(name('BUYER_PRIVATE_KEY')),
            ...(url === undefined ? [value(name('RELAYER_PRIVATE_KEY'))] : authSecrets(auth)),
          ],
        }),
      })(env);
    },
  };
}

export const SMOKE_TARGETS: readonly SmokeTarget[] = [
  evmTestnet({
    id: 'base-sepolia',
    network: 'eip155:84532',
    rpcVariable: 'X402_TESTNET_RPC_URL',
    defaultRpc: 'https://base-sepolia-rpc.publicnode.com',
    facilitatorVariable: 'X402_TESTNET_FACILITATOR_URL',
    defaultFacilitator: 'https://x402.org/facilitator',
    explorer: 'https://sepolia.basescan.org',
  }),
  evmTestnet({
    id: 'base-sepolia-permit2',
    network: 'eip155:84532',
    rpcVariable: 'X402_TESTNET_RPC_URL',
    defaultRpc: 'https://base-sepolia-rpc.publicnode.com',
    facilitatorVariable: 'X402_TESTNET_FACILITATOR_URL',
    defaultFacilitator: 'https://x402.org/facilitator',
    explorer: 'https://sepolia.basescan.org',
    assetTransferMethod: 'permit2',
    // The buyer approves Permit2 for USDC once, which costs gas
    onlyWhenNamed: true,
  }),
  evmTestnet({
    id: 'arbitrum-sepolia',
    network: 'eip155:421614',
    rpcVariable: 'X402_ARBITRUM_SEPOLIA_RPC_URL',
    defaultRpc: 'https://arbitrum-sepolia-rpc.publicnode.com',
    facilitatorVariable: 'X402_ARBITRUM_SEPOLIA_FACILITATOR_URL',
    defaultFacilitator: 'https://facilitator.payai.network',
    explorer: 'https://sepolia.arbiscan.io',
    // The buyer needs Arbitrum Sepolia USDC as well
    onlyWhenNamed: true,
  }),
  {
    id: 'solana-devnet',
    kind: 'testnet',
    family: 'svm',
    network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    explorer: (tx) => `${SOLANA_EXPLORER}/${tx}?cluster=devnet`,
    resolve: resolver({
      required: ['X402_SOLANA_DEVNET_BUYER_SECRET_KEY', 'X402_SOLANA_DEVNET_MERCHANT_ADDRESS'],
      settings: (value, env) => ({
        rpcUrl: read(env, 'X402_SOLANA_DEVNET_RPC_URL') ?? 'https://api.devnet.solana.com',
        payTo: value('X402_SOLANA_DEVNET_MERCHANT_ADDRESS'),
        buyerKey: value('X402_SOLANA_DEVNET_BUYER_SECRET_KEY'),
        facilitator: remote(
          read(env, 'X402_SOLANA_DEVNET_FACILITATOR_URL') ?? 'https://x402.org/facilitator',
        ),
        amount: amountFor(env, 'testnet'),
        secrets: [value('X402_SOLANA_DEVNET_BUYER_SECRET_KEY')],
      }),
    }),
  },
  nearTarget('testnet'),
  // Mainnet: real funds, so every target also needs ALLOW_X402_MAINNET=true and
  // an explicit facilitator or relayer, never a default
  baseMainnet('base'),
  // The buyer approves Permit2 for USDC once, which costs gas
  baseMainnet('base-permit2', 'permit2'),
  {
    id: 'solana',
    kind: 'mainnet',
    family: 'svm',
    network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    explorer: (tx) => `${SOLANA_EXPLORER}/${tx}`,
    resolve: resolver({
      required: [
        'ALLOW_X402_MAINNET',
        'X402_SOLANA_MAINNET_BUYER_SECRET_KEY',
        'X402_SOLANA_MAINNET_MERCHANT_ADDRESS',
        'X402_SOLANA_MAINNET_FACILITATOR_URL',
      ],
      settings: (value, env) => {
        const auth = mainnetAuth(env, 'X402_SOLANA_MAINNET_FACILITATOR_TOKEN');
        return {
          rpcUrl: read(env, 'X402_SOLANA_MAINNET_RPC_URL') ?? 'https://api.mainnet-beta.solana.com',
          payTo: value('X402_SOLANA_MAINNET_MERCHANT_ADDRESS'),
          buyerKey: value('X402_SOLANA_MAINNET_BUYER_SECRET_KEY'),
          facilitator: remote(value('X402_SOLANA_MAINNET_FACILITATOR_URL'), auth),
          amount: amountFor(env, 'mainnet'),
          secrets: [value('X402_SOLANA_MAINNET_BUYER_SECRET_KEY'), ...authSecrets(auth)],
        };
      },
    }),
  },
  nearTarget('mainnet'),
];

// Caps in decimal USDC: one payment, and the whole run
const LIMITS: Readonly<Record<SmokeKind, { readonly payment: string; readonly total: string }>> = {
  testnet: { payment: '1.00', total: '1.00' },
  mainnet: { payment: '0.10', total: '0.10' },
};
const USDC_DECIMALS = 6;

export interface SmokePlan {
  readonly run: readonly { readonly target: SmokeTarget; readonly settings: SmokeSettings }[];
  /** Targets left out for missing settings, when none was named */
  readonly skipped: readonly { readonly id: string; readonly missing: readonly string[] }[];
  /** Problems that fail the run before anything is spent */
  readonly errors: readonly string[];
}

/**
 * Selects smoke targets. Explicit `X402_SMOKE_TARGETS` cannot pass by skipping:
 * unknown names or missing settings fail. Without names, select configured
 * testnet targets except `onlyWhenNamed`; select no mainnet targets.
 */
export function planSmoke(
  kind: SmokeKind,
  env: Env,
  targets: readonly SmokeTarget[] = SMOKE_TARGETS,
): SmokePlan {
  const ofKind = targets.filter((target) => target.kind === kind);
  const requested = read(env, 'X402_SMOKE_TARGETS')
    ?.split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  const errors: string[] = [];
  const run: SmokePlan['run'][number][] = [];
  const skipped: SmokePlan['skipped'][number][] = [];

  if (requested === undefined) {
    for (const target of ofKind) {
      const { missing, settings } = target.resolve(env);
      // Real funds, or a target that needs extra preparation, run only when named
      const needsName = kind === 'mainnet' || target.onlyWhenNamed === true;
      if (!needsName && settings !== undefined) run.push({ target, settings });
      else {
        skipped.push({
          id: target.id,
          missing: needsName ? ['X402_SMOKE_TARGETS', ...missing] : missing,
        });
      }
    }
  } else {
    for (const id of new Set(requested)) {
      const target = ofKind.find((candidate) => candidate.id === id);
      if (target === undefined) {
        errors.push(
          `unknown ${kind} smoke target "${id}"; choose from ${ofKind.map((t) => t.id).join(', ')}`,
        );
        continue;
      }
      const { missing, settings } = target.resolve(env);
      if (settings === undefined) {
        errors.push(`smoke target "${id}" needs ${missing.join(', ')}`);
      } else if (kind === 'mainnet' && read(env, 'ALLOW_X402_MAINNET') !== 'true') {
        errors.push(`smoke target "${id}" needs ALLOW_X402_MAINNET=true`);
      } else {
        run.push({ target, settings });
      }
    }
  }

  // Bound the spend before anything is signed
  const limit = LIMITS[kind];
  const cap = (name: string, value: string): bigint | undefined => {
    try {
      return parseCanonicalAmount(value, USDC_DECIMALS);
    } catch {
      errors.push(`${name} "${value}" is not a decimal USDC amount with at most 6 places`);
      return undefined;
    }
  };
  const perPayment = cap('the payment cap', limit.payment) as bigint;
  const total = cap('X402_SMOKE_MAX_TOTAL', read(env, 'X402_SMOKE_MAX_TOTAL') ?? limit.total);
  let spend = 0n;
  for (const { target, settings } of run) {
    const amount = cap(`the amount for "${target.id}"`, settings.amount);
    if (amount === undefined) continue;
    if (amount > perPayment) {
      errors.push(
        `smoke target "${target.id}" would pay ${settings.amount} USDC, above the ${kind} cap of ${limit.payment}`,
      );
    }
    spend += amount;
  }
  if (total !== undefined && spend > total) {
    errors.push(
      `this run would spend more than X402_SMOKE_MAX_TOTAL allows (${read(env, 'X402_SMOKE_MAX_TOTAL') ?? limit.total} USDC)`,
    );
  }
  return { run, skipped, errors };
}
