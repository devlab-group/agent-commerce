/**
 * Reconciliation against a local Anvil chain: EIP-3009 and Permit2 evidence,
 * plus a CLI run resolving uncertain x402 and MPP attempts from the gateway.
 *
 * The tests mine past Anvil's finality lag. Loopback facilitators settle the
 * payments; their request logs check for calls during reconciliation.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { x402Client } from '@x402/core/client';
import { PERMIT2_ADDRESS } from '@x402/evm';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import Database from 'better-sqlite3';
import { Challenge } from 'mppx';
import { charge as clientCharge } from 'mppx/evm/client';
import {
  type Chain,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  erc20Abi,
  type Hash,
  http,
  keccak256,
  maxUint256,
  pad,
  parseAbi,
  parseEventLogs,
  publicActions,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runReconcileCommand } from '../../../src/cli/commands/reconcile';
import { parseConfig } from '../../../src/config';
import {
  type BackendExecutor,
  type CommerceResource,
  NOOP_LOGGER,
  PAYMENT_HEADER,
  type PaymentAttempt,
  type PaymentContext,
  type PaymentProvider,
  type PaymentReconciliationResult,
} from '../../../src/core';
import { createGateway } from '../../../src/gateway';
import { createConfiguredPaymentProviders } from '../../../src/gateway/payment-providers';
import { createPaymentProof } from '../../../src/payments/x402';
import { createX402PaymentProvider } from '../../../src/payments/x402/provider';
import { type AnvilHandle, deployLocalChain, startAnvil } from '../../../src/payments/x402/testing';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import { locatorOf } from '../../fixtures/x402/locator';
import {
  type LoopbackFacilitator,
  startLoopbackFacilitator,
} from '../../fixtures/x402/loopback-facilitator';
import { type LossyRpc, startLossyRpc, unreachableRpcUrl } from '../../fixtures/x402/lossy-rpc';
import { installMulticall3, installPermit2 } from '../../fixtures/x402/permit2-contracts';
import { readBalances, waitForBalances } from '../../fixtures/x402/settlement';
import { createCapturingIo } from '../../unit/cli/fixtures';

const PORT = 18796;
const OTHER_CHAIN_PORT = 18797;
const NETWORK = 'eip155:31337';
const ONE_USDC = 1_000_000n;
// Mine past Anvil's finality lag
const FINALITY_BLOCKS = 65;
// MockUSDC's authorizationState mapping
const AUTHORIZATION_STATE_SLOT = 3n;

const RESOURCE: CommerceResource = {
  id: 'demo.report',
  name: 'Demo report',
  description: 'A paid demo report',
  handler: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
  pricing: { type: 'fixed', amount: '1.00', currency: 'USD' },
  exposedVia: ['http'],
  paymentMethods: ['x402'],
};

const SELF_SUBMIT_ABI = parseAbi([
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
]);
const INVALIDATE_ABI = parseAbi([
  'function invalidateUnorderedNonces(uint256 wordPos, uint256 mask)',
]);

let anvil: AnvilHandle;
let otherChain: AnvilHandle;
let deployment: Awaited<ReturnType<typeof deployLocalChain>>;
let facilitator: LoopbackFacilitator;
let chain: Chain;

type Method = 'eip3009' | 'permit2';

function x402Provider(method: Method, maxTimeoutSeconds: number, rpcUrl = anvil.rpcUrl) {
  return createX402PaymentProvider({
    network: NETWORK,
    rpcUrl,
    asset: deployment.asset,
    assetName: deployment.assetName,
    assetVersion: deployment.assetVersion,
    assetDecimals: deployment.assetDecimals,
    payTo: deployment.merchant.address,
    assetTransferMethod: method,
    maxTimeoutSeconds,
    facilitator: { mode: 'remote', url: facilitator.url, auth: { type: 'none' } },
  });
}

function testClient() {
  return createTestClient({ mode: 'anvil', chain, transport: http(anvil.rpcUrl) }).extend(
    publicActions,
  );
}

function buyerWallet() {
  return createWalletClient({
    account: privateKeyToAccount(deployment.buyer.privateKey),
    chain,
    transport: http(anvil.rpcUrl),
  }).extend(publicActions);
}

const mineFinal = () => testClient().mine({ blocks: FINALITY_BLOCKS });

// Temporarily advance finalized time, then restore the chain and clock.
// Permit2 simulation uses chain time, so leaving it ahead of the buyer's
// clock would invalidate later cases.
async function atFinalizedTime<T>(timestamp: bigint, read: () => Promise<T>): Promise<T> {
  const snapshot = await testClient().snapshot();
  try {
    await testClient().setNextBlockTimestamp({ timestamp });
    await mineFinal();
    return await read();
  } finally {
    await testClient().revert({ id: snapshot });
  }
}

interface Verified {
  readonly provider: PaymentProvider;
  readonly context: Parameters<PaymentProvider['settle']>[0];
  readonly locator: Readonly<Record<string, unknown>>;
  readonly proof: Record<string, unknown>;
  readonly attempt: PaymentAttempt;
}

// Build a verified payment and the attempt data the pipeline would reserve
async function verified(provider: PaymentProvider, method: Method): Promise<Verified> {
  const createdAt = new Date().toISOString();
  const paymentContext: PaymentContext = {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    resource: RESOURCE,
    amount: '1.00',
    currency: 'USD',
    requestedAt: createdAt,
  };
  const requirement = await provider.createRequirement(paymentContext);
  let encoded: string;
  if (method === 'eip3009') {
    encoded = await createPaymentProof({
      buyerPrivateKey: deployment.buyer.privateKey,
      accepts: requirement.challenge.accepts[0] as Record<string, unknown>,
    });
  } else {
    const client = new x402Client();
    registerExactEvmScheme(client, {
      signer: privateKeyToAccount(deployment.buyer.privateKey),
      networks: [NETWORK],
    });
    client.setSpendControls(false);
    const payload = await client.createPaymentPayload(requirement.challenge.envelope as never);
    encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  }
  const submission = { method: 'x402' as const, payload: encoded };
  const base = { requestId: requirement.requestId, resource: RESOURCE, requirement, submission };
  const verification = await provider.verify(base);
  expect(verification.status).toBe('verified');
  return {
    provider,
    context: { ...base, verification },
    locator: locatorOf(verification),
    proof: JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Record<string, unknown>,
    attempt: {
      id: `pa_${paymentContext.requestId}`,
      requestId: paymentContext.requestId,
      resourceId: RESOURCE.id,
      provider: 'x402',
      replayKey: verification.replayKey ?? 'replay',
      status: 'settlement-uncertain',
      amount: '1.00',
      currency: 'USDC',
      createdAt,
      updatedAt: createdAt,
    },
  };
}

async function settle(payment: Verified): Promise<Hash> {
  const settled = await payment.provider.settle(payment.context);
  expect(settled.status).toBe('settled');
  return settled.externalReference as Hash;
}

async function reconcile(
  payment: Verified,
  attempt: Partial<PaymentAttempt> = {},
  provider: PaymentProvider = payment.provider,
): Promise<PaymentReconciliationResult> {
  const read = provider.reconcile;
  if (read === undefined) throw new Error('the provider has no reconcile');
  return read({
    attempt: { ...payment.attempt, ...attempt },
    locator: payment.locator,
    now: new Date().toISOString(),
  });
}

async function blockOf(hash: Hash): Promise<string> {
  return String((await testClient().getTransactionReceipt({ hash })).blockNumber);
}

beforeAll(async () => {
  [anvil, otherChain] = await Promise.all([
    startAnvil({ port: PORT, silent: true }),
    startAnvil({ port: OTHER_CHAIN_PORT, silent: true, chainId: 31338 }),
  ]);
  deployment = await deployLocalChain({ rpcUrl: anvil.rpcUrl, buyerInitialBalance: '100.00' });
  chain = {
    id: 31337,
    name: 'anvil',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [anvil.rpcUrl] } },
  };
  await installPermit2(anvil.rpcUrl);
  await installMulticall3(anvil.rpcUrl);
  const wallet = buyerWallet();
  await wallet.waitForTransactionReceipt({
    hash: await wallet.writeContract({
      address: deployment.asset,
      abi: erc20Abi,
      functionName: 'approve',
      args: [PERMIT2_ADDRESS, maxUint256],
    }),
  });
  facilitator = await startLoopbackFacilitator({
    evm: {
      chains: [{ network: NETWORK, rpcUrl: anvil.rpcUrl }],
      signerPrivateKey: deployment.facilitator.privateKey,
    },
  });
  // Finalize the contract deployments before reading their state
  await mineFinal();
}, 120_000);

afterAll(async () => {
  await facilitator?.close();
  await Promise.all([anvil?.stop(), otherChain?.stop()]);
});

describe('x402 reconcile: settled', () => {
  it('from the transaction hash, once final', async () => {
    const payment = await verified(x402Provider('eip3009', 3600), 'eip3009');
    const hash = await settle(payment);
    await mineFinal();

    const result = await reconcile(payment, { externalReference: hash });

    expect(result).toMatchObject({
      outcome: 'settled',
      reason: 'transfer_final',
      externalReference: hash,
      evidence: { transactionHash: hash, blockNumber: await blockOf(hash) },
    });
  });

  it('without a hash, from the AuthorizationUsed search', async () => {
    const payment = await verified(x402Provider('eip3009', 3600), 'eip3009');
    const hash = await settle(payment);
    await mineFinal();

    const result = await reconcile(payment);

    expect(result).toMatchObject({
      outcome: 'settled',
      externalReference: hash,
      evidence: { blockNumber: await blockOf(hash) },
    });
  });

  it('for an authorization the buyer submitted themselves', async () => {
    const payment = await verified(x402Provider('eip3009', 3600), 'eip3009');
    const signed = payment.proof['payload'] as {
      signature: `0x${string}`;
      authorization: {
        from: `0x${string}`;
        to: `0x${string}`;
        value: string;
        validAfter: string;
        validBefore: string;
        nonce: `0x${string}`;
      };
    };
    const { from, to, value, validAfter, validBefore, nonce } = signed.authorization;
    const wallet = buyerWallet();
    const hash = await wallet.writeContract({
      address: deployment.asset,
      abi: SELF_SUBMIT_ABI,
      functionName: 'transferWithAuthorization',
      args: [
        from,
        to,
        BigInt(value),
        BigInt(validAfter),
        BigInt(validBefore),
        nonce,
        signed.signature,
      ],
    });
    expect((await wallet.waitForTransactionReceipt({ hash })).status).toBe('success');
    await mineFinal();

    expect(await reconcile(payment)).toMatchObject({ outcome: 'settled', externalReference: hash });
  });

  it('Permit2, from the hash and the proxy calldata', async () => {
    const payment = await verified(x402Provider('permit2', 3600), 'permit2');
    const hash = await settle(payment);
    await mineFinal();

    expect(await reconcile(payment, { externalReference: hash })).toMatchObject({
      outcome: 'settled',
      externalReference: hash,
      evidence: { blockNumber: await blockOf(hash) },
    });
  });

  it('two Permit2 payments of one amount from one owner each match their own nonce', async () => {
    const provider = x402Provider('permit2', 3600);
    const first = await verified(provider, 'permit2');
    const second = await verified(provider, 'permit2');
    const firstHash = await settle(first);
    const secondHash = await settle(second);
    await mineFinal();

    expect(await reconcile(first)).toMatchObject({
      outcome: 'settled',
      externalReference: firstHash,
    });
    expect(await reconcile(second)).toMatchObject({
      outcome: 'settled',
      externalReference: secondHash,
    });
  });

  it('in the last block before the expiry, the end of the search window', async () => {
    const payment = await verified(x402Provider('eip3009', 30), 'eip3009');
    const hash = await settle(payment);
    const validBefore = BigInt(payment.locator['validBefore'] as string);

    expect(await atFinalizedTime(validBefore, () => reconcile(payment))).toMatchObject({
      outcome: 'settled',
      externalReference: hash,
    });
  });
});

describe('x402 reconcile: not settled', () => {
  // EIP-3009 lands while the timestamp is below validBefore; Permit2 while it
  // is at most the deadline
  it.each([
    ['eip3009', 'validBefore', 0n],
    ['permit2', 'deadline', 1n],
  ] as const)(
    '%s: unknown at the last second it can land, not-settled from the next',
    async (method, field, offset) => {
      const payment = await verified(x402Provider(method, 30), method);
      const endsAt = BigInt(payment.locator[field] as string) + offset;

      expect(await atFinalizedTime(endsAt - 1n, () => reconcile(payment))).toMatchObject({
        outcome: 'unknown',
        reason: 'not_expired',
      });
      expect(await atFinalizedTime(endsAt, () => reconcile(payment))).toMatchObject({
        outcome: 'not-settled',
        reason: 'expired_unused',
        evidence: { nonceUsed: false, finalizedAt: new Date(Number(endsAt) * 1000).toISOString() },
      });
    },
  );
});

describe('x402 reconcile: unknown', () => {
  it('before expiry, with the expiry as the retry time', async () => {
    const payment = await verified(x402Provider('eip3009', 3600), 'eip3009');
    await mineFinal();

    expect(await reconcile(payment)).toEqual({
      outcome: 'unknown',
      reason: 'not_expired',
      retryAfter: payment.locator['expiresAt'],
      evidence: expect.objectContaining({ finalizedBlock: expect.any(String) }),
    });
  });

  it('for a used nonce without a transfer, as after cancelAuthorization', async () => {
    const payment = await verified(x402Provider('eip3009', 3600), 'eip3009');
    const { from, nonce } = payment.locator as { from: `0x${string}`; nonce: `0x${string}` };
    const inner = keccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }],
        [from, AUTHORIZATION_STATE_SLOT],
      ),
    );
    const slot = keccak256(
      encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [nonce, inner]),
    );
    await testClient().setStorageAt({ address: deployment.asset, index: slot, value: pad('0x01') });
    await mineFinal();
    const used = await testClient().readContract({
      address: deployment.asset,
      abi: parseAbi(['function authorizationState(address, bytes32) view returns (bool)']),
      functionName: 'authorizationState',
      args: [from, nonce],
    });
    expect(used).toBe(true);

    expect(await reconcile(payment)).toMatchObject({
      outcome: 'unknown',
      reason: 'used_without_record',
      evidence: { nonceUsed: true },
    });
  });

  it('for a Permit2 nonce invalidated by its owner', async () => {
    const payment = await verified(x402Provider('permit2', 3600), 'permit2');
    const nonce = BigInt(payment.locator['nonce'] as string);
    const wallet = buyerWallet();
    const hash = await wallet.writeContract({
      address: PERMIT2_ADDRESS,
      abi: INVALIDATE_ABI,
      functionName: 'invalidateUnorderedNonces',
      args: [nonce >> 8n, 1n << (nonce & 0xffn)],
    });
    expect((await wallet.waitForTransactionReceipt({ hash })).status).toBe('success');
    await mineFinal();

    expect(await reconcile(payment)).toMatchObject({
      outcome: 'unknown',
      reason: 'used_without_record',
    });
  });

  it('for a reference that is not on chain, from the state read', async () => {
    const payment = await verified(x402Provider('eip3009', 3600), 'eip3009');
    await mineFinal();

    expect(await reconcile(payment, { externalReference: `0x${'ee'.repeat(32)}` })).toMatchObject({
      outcome: 'unknown',
      reason: 'not_expired',
    });
  });

  it('for a reference to another payment of the same amount', async () => {
    const provider = x402Provider('eip3009', 3600);
    const other = await verified(provider, 'eip3009');
    const otherHash = await settle(other);
    const payment = await verified(provider, 'eip3009');
    await mineFinal();

    expect(await reconcile(payment, { externalReference: otherHash })).toMatchObject({
      outcome: 'unknown',
      reason: 'not_expired',
    });
  });

  it('for an RPC that serves another chain', async () => {
    const payment = await verified(x402Provider('eip3009', 3600), 'eip3009');

    const result = await reconcile(payment, {}, x402Provider('eip3009', 3600, otherChain.rpcUrl));

    expect(result).toEqual({
      outcome: 'unknown',
      reason: 'chain_mismatch',
      evidence: { chainId: 31338, expectedChainId: 31337 },
    });
  });

  it('for a transfer in a block that is not yet final, with or without its hash', async () => {
    const payment = await verified(x402Provider('eip3009', 3600), 'eip3009');
    const hash = await settle(payment);

    expect(await reconcile(payment, { externalReference: hash })).toMatchObject({
      outcome: 'unknown',
      reason: 'not_final',
      evidence: { transactionHash: hash },
    });
    expect(await reconcile(payment)).toMatchObject({ outcome: 'unknown', reason: 'not_final' });
  });

  it('for an RPC error, naming the RPC by origin only', async () => {
    const payment = await verified(x402Provider('eip3009', 3600), 'eip3009');
    const origin = await unreachableRpcUrl();
    const broken = x402Provider('eip3009', 3600, `${origin}/v2/secret-key?apikey=hunter2`);

    const result = await reconcile(payment, {}, broken);

    expect(result).toMatchObject({
      outcome: 'unknown',
      reason: 'rpc_error',
      evidence: { rpc: origin, error: expect.any(String) },
    });
    expect(JSON.stringify(result)).not.toMatch(/secret-key|hunter2/);
  });

  it('calls no facilitator endpoint', async () => {
    const payment = await verified(x402Provider('eip3009', 3600), 'eip3009');
    const hash = await settle(payment);
    await mineFinal();
    const before = [...facilitator.requests];

    await reconcile(payment, { externalReference: hash });
    await reconcile(payment);
    await reconcile(await verified(x402Provider('permit2', 3600), 'permit2'));

    // Allow the /verify request from verified() when checking for reconciliation calls
    expect(facilitator.requests.slice(before.length).filter((r) => !r.endsWith('/verify'))).toEqual(
      [],
    );
  });
});

describe('agent-commerce reconcile through the gateway', () => {
  let lossy: LossyRpc;
  let lossyFacilitator: LoopbackFacilitator;
  let dir: string;

  beforeAll(async () => {
    lossy = await startLossyRpc(anvil.rpcUrl);
    lossyFacilitator = await startLoopbackFacilitator({
      evm: {
        chains: [{ network: NETWORK, rpcUrl: lossy.url }],
        signerPrivateKey: deployment.facilitator.privateKey,
      },
    });
    dir = mkdtempSync(join(tmpdir(), 'oac-reconcile-e2e-'));
  });

  afterAll(async () => {
    await lossyFacilitator?.close();
    await lossy?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  // Snapshot all SQLite tables to check that a run leaves stored rows unchanged
  function dump(path: string): Record<string, unknown[]> {
    const db = new Database(path, { readonly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[];
      return Object.fromEntries(
        tables.map(({ name }) => [
          name,
          db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
        ]),
      );
    } finally {
      db.close();
    }
  }

  it('resolves an uncertain x402 attempt and an uncertain MPP attempt in one run', async () => {
    const dbPath = join(dir, 'receipts.sqlite');
    const remote = { mode: 'remote', url: lossyFacilitator.url, auth: { type: 'none' } };
    const config = parseConfig(
      {
        version: 1,
        merchant: {
          id: 'reconcile-e2e',
          name: 'Reconcile E2E',
          publicBaseUrl: 'http://127.0.0.1:8080',
        },
        server: { port: 8080, host: '127.0.0.1', allowedOrigins: [] },
        storage: { receipts: { driver: 'sqlite', path: dbPath } },
        protocols: { http: { enabled: true }, mcp: { enabled: false, mountPath: '/mcp' } },
        resources: Object.fromEntries(
          ['x402', 'mpp'].map((rail) => [
            `${rail}_report`,
            {
              name: `Report paid with ${rail}`,
              backend: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
              pricing: { type: 'fixed', amount: '1.00', currency: 'USDC' },
              expose: ['http'],
              payments: [rail],
            },
          ]),
        ),
        payments: {
          x402: {
            enabled: true,
            network: NETWORK,
            rpcUrl: anvil.rpcUrl,
            asset: deployment.asset,
            assetName: deployment.assetName,
            assetVersion: deployment.assetVersion,
            assetDecimals: deployment.assetDecimals,
            payTo: deployment.merchant.address,
            maxTimeoutSeconds: 3600,
            facilitator: remote,
          },
          mpp: {
            enabled: true,
            network: NETWORK,
            rpcUrl: anvil.rpcUrl,
            asset: deployment.asset,
            assetName: deployment.assetName,
            assetVersion: deployment.assetVersion,
            recipient: deployment.merchant.address,
            realm: 'gateway.e2e',
            challengeSecret: 'reconcile-e2e-challenge-secret'.padEnd(32, 'x'),
            facilitator: remote,
          },
        },
      },
      {},
    );
    const balanceQuery = {
      rpcUrl: anvil.rpcUrl,
      asset: deployment.asset,
      buyer: deployment.buyer.address,
      merchant: deployment.merchant.address,
    };
    const store = createSqliteReceiptStore({ path: dbPath });
    await store.init();
    const backend: BackendExecutor = {
      async call() {
        return { status: 200, body: { report: 'ok' }, headers: {}, durationMs: 1 };
      },
    };
    const gateway = await createGateway({
      config,
      store,
      paymentProviders: await createConfiguredPaymentProviders(config.payments, NOOP_LOGGER),
      protocolAdapters: [],
      backend,
    });
    const invoke = (resourceId: string, headers: Record<string, string> = {}) =>
      gateway.server.inject({
        method: 'POST',
        url: `/api/resources/${resourceId}/invoke`,
        headers: { 'content-type': 'application/json', ...headers },
        payload: {},
      });

    const before = await readBalances(balanceQuery);
    try {
      const x402Challenge = await invoke('x402_report');
      expect(x402Challenge.statusCode).toBe(402);
      const proof = await createPaymentProof({
        buyerPrivateKey: deployment.buyer.privateKey,
        accepts: (x402Challenge.json().payment as { accepts: Record<string, unknown>[] })
          .accepts[0] as Record<string, unknown>,
      });
      const x402Paid = await invoke('x402_report', { [PAYMENT_HEADER]: proof });
      expect(x402Paid.json()).toMatchObject({ details: { settlementUncertain: true } });

      const mppChallenge = await invoke('mpp_report');
      expect(mppChallenge.statusCode).toBe(402);
      const credential = await clientCharge({
        account: privateKeyToAccount(deployment.buyer.privateKey),
        authorization: { name: deployment.assetName, version: deployment.assetVersion },
      }).createCredential({
        challenge: Challenge.deserialize(String(mppChallenge.headers['www-authenticate'])) as never,
        context: {},
      });
      const mppPaid = await invoke('mpp_report', { authorization: String(credential) });
      expect(mppPaid.json()).toMatchObject({ details: { settlementUncertain: true } });
    } finally {
      await gateway.close();
      await store.close();
    }
    // Confirm both transfers landed despite the lost settlement responses
    const after = await waitForBalances(
      balanceQuery,
      (snapshot) => before.buyer - snapshot.buyer === 2n * ONE_USDC,
      30_000,
    );
    expect(after.merchant - before.merchant).toBe(2n * ONE_USDC);
    await mineFinal();

    const run = async (options: { dryRun?: boolean } = {}) => {
      const io = createCapturingIo();
      const code = await runReconcileCommand(
        { json: true, actor: 'e2e-operator', ...options },
        io,
        { loadConfig: async () => config },
      );
      expect(code).toBe(0);
      expect(io.err).toEqual([]);
      return JSON.parse(io.out.join('\n')) as {
        counts: Record<string, number>;
        entries: { provider: string; outcome: string; written: boolean; externalReference: Hash }[];
      };
    };
    const facilitatorCalls = lossyFacilitator.requests.length;
    const untouched = dump(dbPath);

    const dryRun = await run({ dryRun: true });
    expect(dryRun.counts).toEqual({
      candidates: 2,
      settled: 2,
      notSettled: 0,
      unknown: 0,
      resolved: 0,
    });
    expect(dump(dbPath)).toEqual(untouched);

    const resolved = await run();
    expect(resolved.counts).toMatchObject({ settled: 2, resolved: 2 });
    expect(resolved.entries.map((entry) => entry.provider).sort()).toEqual(['mpp', 'x402']);

    const resolvedState = dump(dbPath);
    expect((await run()).entries).toEqual([]);
    expect(dump(dbPath)).toEqual(resolvedState);
    expect(lossyFacilitator.requests).toHaveLength(facilitatorCalls);

    // Each reference is a successful transaction moving one USDC from the buyer to the merchant
    const reader = createSqliteReceiptStore({ path: dbPath });
    await reader.init();
    try {
      const attempts = await reader.listPaymentAttempts();
      expect(attempts).toHaveLength(2);
      for (const attempt of attempts) {
        expect(attempt).toMatchObject({
          status: 'settled',
          resolution: { method: 'reconcile', actor: 'e2e-operator', reason: 'transfer_final' },
        });
        const receipt = await testClient().getTransactionReceipt({
          hash: attempt.externalReference as Hash,
        });
        expect(receipt.status).toBe('success');
        const transfers = parseEventLogs({
          abi: erc20Abi,
          logs: receipt.logs,
          eventName: 'Transfer',
        });
        expect(
          transfers.map(({ address, args }) => ({ address: address.toLowerCase(), ...args })),
        ).toEqual([
          {
            address: deployment.asset.toLowerCase(),
            from: deployment.buyer.address,
            to: deployment.merchant.address,
            value: ONE_USDC,
          },
        ]);
      }
    } finally {
      await reader.close();
    }
  }, 120_000);
});
