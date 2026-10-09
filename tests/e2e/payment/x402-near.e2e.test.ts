/**
 * NEAR `exact` settlement on a local sandbox through the gateway's remote-only
 * NEAR path. The SDK client signs delegates; its HTTP facilitator uses a
 * sandbox relayer. A NEP-141 contract occupies the testnet USDC account ID,
 * and the sandbox uses `near:testnet`, the SDK's only testnet ID. Balances and
 * receipts come from the sandbox.
 */
import { KeyPair } from '@near-js/crypto';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentRequired } from '@x402/core/types';
import { createClientNearSigner, decodeSignedDelegateB64 } from '@x402/near';
import { ExactNearScheme } from '@x402/near/exact/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type GatewayConfig, parseConfig } from '../../../src/config';
import { type BackendExecutor, isCommerceError, NOOP_LOGGER } from '../../../src/core';
import { createGateway, type GatewayInstance } from '../../../src/gateway';
import { createConfiguredPaymentProviders } from '../../../src/gateway/payment-providers';
import { createX402PaymentProvider } from '../../../src/payments/x402';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import {
  type LoopbackFacilitator,
  startLoopbackFacilitator,
} from '../../fixtures/x402/loopback-facilitator';
import { startLossyRpc } from '../../fixtures/x402/lossy-rpc';
import { buildSignedDelegate } from '../../fixtures/x402/near-delegate';
import {
  createNearAccount,
  deployUsdc,
  ftBalance,
  isNearSandboxAvailable,
  NEAR_TESTNET_USDC,
  type NearSandbox,
  type NearTestAccount,
  nearRpc,
  startNearSandbox,
  waitForFinal,
} from '../../fixtures/x402/near-sandbox';

const NETWORK = 'near:testnet';
const RPC_PORT = 19030;
const RESOURCE_ID = 'market_report';
const PRICE = 1_000_000n;

const HAS_SANDBOX = isNearSandboxAvailable();
if (!HAS_SANDBOX && process.env['CI']) {
  throw new Error(
    'near-sandbox is not on PATH and NEAR_SANDBOX_BIN is unset, but CI is set. This suite ' +
      'settles on a local NEAR sandbox and must not be skipped in CI.',
  );
}
const describeWithSandbox = HAS_SANDBOX ? describe : describe.skip;

let sandbox: NearSandbox;
let facilitator: LoopbackFacilitator;
let gateway: GatewayInstance;
let config: GatewayConfig;
let store: ReturnType<typeof createSqliteReceiptStore>;
let buyer: NearTestAccount;
let merchant: NearTestAccount;
let relayer: NearTestAccount;
let backendCalls = 0;
// Holds a request between reservation and settlement, which follows the backend
let backendDelayMs = 0;
let backendFails = false;
// Runs inside the backend call, after reservation and before settlement
let duringBackend: (() => Promise<void>) | undefined;

const backend: BackendExecutor = {
  async call() {
    backendCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, backendDelayMs));
    await duringBackend?.();
    if (backendFails) throw new Error('backend down');
    return { status: 200, body: { report: 'ok' }, headers: {}, durationMs: 1 };
  },
};

async function balances() {
  const [buyerBalance, merchantBalance] = await Promise.all([
    ftBalance(sandbox.rpcUrl, NEAR_TESTNET_USDC, buyer.accountId),
    ftBalance(sandbox.rpcUrl, NEAR_TESTNET_USDC, merchant.accountId),
  ]);
  return { buyer: buyerBalance, merchant: merchantBalance };
}

async function expectBalances(expected: { buyer: bigint; merchant: bigint }) {
  await waitForFinal(async () => {
    const current = await balances();
    return current.buyer === expected.buyer && current.merchant === expected.merchant;
  });
}

async function invoke(headers: Record<string, string> = {}) {
  return gateway.server.inject({
    method: 'POST',
    url: `/api/resources/${RESOURCE_ID}/invoke`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: {},
  });
}

type NearProof = { accepted: Record<string, unknown>; payload: { signedDelegateAction: string } };

async function sign(offered: PaymentRequired): Promise<NearProof> {
  const client = new x402Client();
  client.register(
    NETWORK,
    new ExactNearScheme(
      createClientNearSigner({
        accountId: buyer.accountId,
        secretKey: buyer.secretKey,
        rpcUrls: { [NETWORK]: sandbox.rpcUrl },
      }),
    ),
  );
  client.setSpendControls(false);
  return (await client.createPaymentPayload(offered)) as unknown as NearProof;
}

async function challenge(): Promise<PaymentRequired> {
  const unpaid = await invoke();
  expect(unpaid.statusCode).toBe(402);
  return new x402HTTPClient(new x402Client()).getPaymentRequiredResponse(
    (name) => unpaid.headers[name.toLowerCase()] as string | undefined,
  );
}

const nonceOf = (proof: NearProof) =>
  decodeSignedDelegateB64(proof.payload.signedDelegateAction).delegate.nonce;

const header = (proof: unknown) => ({
  'payment-signature': Buffer.from(JSON.stringify(proof)).toString('base64'),
});

// The facilitator's next settlement needs final state that includes the last one
async function finalNonceOf(accountId: string, publicKey: string): Promise<bigint> {
  const key = await nearRpc<{ nonce: number }>(sandbox.rpcUrl, 'query', {
    request_type: 'view_access_key',
    finality: 'final',
    account_id: accountId,
    public_key: publicKey,
  });
  return BigInt(key.nonce);
}

beforeAll(async () => {
  if (!HAS_SANDBOX) return;
  sandbox = await startNearSandbox({ rpcPort: RPC_PORT });
  buyer = await createNearAccount(sandbox, 'buyer');
  merchant = await createNearAccount(sandbox, 'merchant');
  relayer = await createNearAccount(sandbox, 'relayer');
  await deployUsdc(sandbox, buyer.accountId, 100_000_000n, [merchant.accountId]);
  facilitator = await startLoopbackFacilitator({
    near: {
      network: NETWORK,
      rpcUrl: sandbox.rpcUrl,
      relayer: { accountId: relayer.accountId, secretKey: relayer.secretKey },
    },
  });
  config = parseConfig(
    {
      version: 1,
      merchant: { id: 'near', name: 'NEAR', publicBaseUrl: 'http://127.0.0.1:8080' },
      server: { port: 8080, host: '127.0.0.1', allowedOrigins: [] },
      storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
      protocols: { http: { enabled: true }, mcp: { enabled: false, mountPath: '/mcp' } },
      resources: {
        [RESOURCE_ID]: {
          name: 'Market report',
          backend: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
          pricing: { type: 'fixed', amount: '1.00', currency: 'USDC' },
          expose: ['http'],
          payments: ['x402'],
        },
      },
      payments: {
        x402: {
          enabled: true,
          // The testnet USDC by default; the sandbox holds a token at its id
          network: NETWORK,
          rpcUrl: sandbox.rpcUrl,
          payTo: merchant.accountId,
          maxTimeoutSeconds: 60,
          facilitator: { mode: 'remote', url: facilitator.url, auth: { type: 'none' } },
        },
      },
    },
    {},
  );
  store = createSqliteReceiptStore({ path: ':memory:' });
  await store.init();
  gateway = await createGateway({
    config,
    store,
    paymentProviders: createConfiguredPaymentProviders(config.payments, NOOP_LOGGER),
    protocolAdapters: [],
    backend,
  });
}, 180_000);

afterAll(async () => {
  await gateway?.close();
  await store?.close();
  await facilitator?.close();
  await sandbox?.stop();
});

describeWithSandbox('x402 NEAR settlement on a local sandbox', () => {
  it('settles an SDK-signed delegate and its inner ft_transfer on chain', async () => {
    const offered = await challenge();
    expect(offered.accepts[0]?.extra).toEqual({});
    const before = await balances();

    const paid = await invoke(header(await sign(offered)));
    expect(paid.statusCode).toBe(200);
    const settlement = new x402HTTPClient(new x402Client()).getPaymentSettleResponse(
      (name) => paid.headers[name.toLowerCase()] as string | undefined,
    );
    expect(settlement).toMatchObject({ success: true, network: NETWORK, payer: buyer.accountId });

    // The relayer's outer transaction, and the token's own receipt within it
    const outcome = await nearRpc<{
      receipts_outcome: { outcome: { executor_id: string; status: Record<string, unknown> } }[];
    }>(sandbox.rpcUrl, 'tx', {
      tx_hash: settlement.transaction,
      sender_account_id: relayer.accountId,
      wait_until: 'FINAL',
    });
    const tokenReceipts = outcome.receipts_outcome.filter(
      (receipt) => receipt.outcome.executor_id === NEAR_TESTNET_USDC,
    );
    expect(tokenReceipts.length).toBeGreaterThan(0);
    for (const receipt of tokenReceipts)
      expect(receipt.outcome.status).toHaveProperty('SuccessValue');
    await expectBalances({ buyer: before.buyer - PRICE, merchant: before.merchant + PRICE });

    const [receipt] = await store.listReceipts({ limit: 1 });
    expect(receipt?.payment).toMatchObject({
      network: NETWORK,
      externalReference: settlement.transaction,
      payer: buyer.accountId,
    });
  });

  it.each<[string, (offer: Record<string, unknown>) => void, string]>([
    [
      'another account',
      (offer) => {
        offer['payTo'] = 'attacker.test.near';
      },
      'invalid_exact_near_payload_recipient_mismatch',
    ],
    [
      'a smaller amount',
      (offer) => {
        offer['amount'] = '1';
      },
      'invalid_exact_near_payload_amount_mismatch',
    ],
  ])('refuses a delegate paying %s, moving nothing', async (_case, tamper, reason) => {
    const offered = await challenge();
    const original = offered.accepts[0] as unknown as Record<string, unknown>;
    // Signed for altered terms, presented as the offer the gateway made
    const altered = { ...original };
    tamper(altered);
    const proof = await sign({ ...offered, accepts: [altered as never] });
    proof.accepted = original;

    const before = await balances();
    const refused = await invoke(header(proof));
    expect(refused.statusCode).toBe(402);
    expect(refused.json().message).toBe(reason);
    expect(await balances()).toEqual(before);
  });

  it('refuses a delegate signed with a function-call access key', async () => {
    // Such a key cannot attach the one yoctoNEAR an ft_transfer needs
    const limited = KeyPair.fromRandom('ed25519');
    await sandbox
      .account(buyer.accountId, buyer.keyPair)
      .addKey(limited.getPublicKey(), NEAR_TESTNET_USDC, ['ft_transfer'], 10n ** 23n);
    await waitForFinal(async () => {
      await finalNonceOf(buyer.accountId, limited.getPublicKey().toString());
      return true;
    });
    const offered = await challenge();
    const nonce = (await finalNonceOf(buyer.accountId, limited.getPublicKey().toString())) + 1n;
    const status = await nearRpc<{ sync_info: { latest_block_height: number } }>(
      sandbox.rpcUrl,
      'status',
      [],
    );
    const { signedDelegateAction } = await buildSignedDelegate({
      keyPair: limited,
      senderId: buyer.accountId,
      receiverId: NEAR_TESTNET_USDC,
      ftReceiver: merchant.accountId,
      amount: PRICE.toString(),
      nonce,
      maxBlockHeight: BigInt(status.sync_info.latest_block_height) + 30n,
    });

    const before = await balances();
    const refused = await invoke(
      header({ x402Version: 2, accepted: offered.accepts[0], payload: { signedDelegateAction } }),
    );
    expect(refused.statusCode).toBe(402);
    expect(refused.json().message).toBe('invalid_exact_near_function_call_key_not_allowed');
    expect(await balances()).toEqual(before);
  });

  it('settles one delegate once when presented on two requests at the same time', async () => {
    const proof = await sign(await challenge());
    const before = await balances();
    const calls = backendCalls;
    const statuses = (await Promise.all([invoke(header(proof)), invoke(header(proof))])).map(
      (response) => response.statusCode,
    );
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(backendCalls - calls).toBe(1);
    await expectBalances({ buyer: before.buyer - PRICE, merchant: before.merchant + PRICE });
  });

  it('reserves the access-key nonce, not the delegate bytes, while the first is settling', async () => {
    const proof = await sign(await challenge());
    // Different delegate bytes and signature, same transfer, key and nonce
    const first = decodeSignedDelegateB64(proof.payload.signedDelegateAction).delegate;
    const { signedDelegateAction } = await buildSignedDelegate({
      keyPair: buyer.keyPair,
      senderId: buyer.accountId,
      receiverId: NEAR_TESTNET_USDC,
      ftReceiver: merchant.accountId,
      amount: PRICE.toString(),
      nonce: first.nonce,
      maxBlockHeight: first.maxBlockHeight,
      gas: 40_000_000_000_000n,
    });
    expect(signedDelegateAction).not.toBe(proof.payload.signedDelegateAction);
    const sibling = { ...proof, payload: { signedDelegateAction } };

    const before = await balances();
    backendDelayMs = 2_000;
    try {
      const [firstResponse, second] = await Promise.all([
        invoke(header(proof)),
        new Promise((resolve) => setTimeout(resolve, 500)).then(() => invoke(header(sibling))),
      ]);
      expect(firstResponse.statusCode).toBe(200);
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe('PAYMENT_REPLAYED');
    } finally {
      backendDelayMs = 0;
    }
    await expectBalances({ buyer: before.buyer - PRICE, merchant: before.merchant + PRICE });
  });

  it('refuses a settled delegate presented again, moving nothing', async () => {
    const proof = await sign(await challenge());
    expect((await invoke(header(proof))).statusCode).toBe(200);
    const nonce = decodeSignedDelegateB64(proof.payload.signedDelegateAction).delegate.nonce;
    await waitForFinal(
      async () =>
        (await finalNonceOf(buyer.accountId, buyer.keyPair.getPublicKey().toString())) >= nonce,
    );
    const after = await balances();

    const replayed = await invoke(header(proof));
    expect(replayed.statusCode).toBe(402);
    expect(replayed.json().message).toBe(
      'invalid_exact_near_payload_delegate_action_nonce_already_used',
    );
    expect(await balances()).toEqual(after);
  });

  it('pays once when the reference client retries a failed backend call with the same nonce', async () => {
    const first = await sign(await challenge());
    const before = await balances();
    const calls = backendCalls;
    backendFails = true;
    try {
      const failed = await invoke(header(first));
      expect(failed.statusCode).toBe(502);
      expect(failed.json().code).toBe('BACKEND_ERROR');
    } finally {
      backendFails = false;
    }
    expect(await balances()).toEqual(before);

    // Nothing reached the chain, so the client's next delegate repeats the nonce
    const retry = await sign(await challenge());
    expect(nonceOf(retry)).toBe(nonceOf(first));
    const paid = await invoke(header(retry));

    expect(paid.statusCode).toBe(200);
    expect(backendCalls - calls).toBe(2);
    await expectBalances({ buyer: before.buyer - PRICE, merchant: before.merchant + PRICE });
  });

  it('pays once when the reference client retries a settlement refused before submission', async () => {
    // A second full-access key moves the buyer's tokens without spending the
    // nonce of the key that signs delegates
    const spare = KeyPair.fromRandom('ed25519');
    await sandbox.account(buyer.accountId, buyer.keyPair).addFullAccessKey(spare.getPublicKey());
    await waitForFinal(async () => {
      await finalNonceOf(buyer.accountId, spare.getPublicKey().toString());
      return true;
    });
    const ftTransfer = (from: string, keyPair: KeyPair, to: string, amount: bigint) =>
      sandbox.account(from, keyPair).functionCall({
        contractId: NEAR_TESTNET_USDC,
        methodName: 'ft_transfer',
        args: { receiver_id: to, amount: amount.toString() },
        gas: 30_000_000_000_000n,
        attachedDeposit: 1n,
      });
    const first = await sign(await challenge());
    const before = await balances();
    const calls = backendCalls;

    // Verified with funds, then drained while the backend runs: the
    // facilitator's check at settle refuses before submitting anything
    duringBackend = async () => {
      await ftTransfer(buyer.accountId, spare, merchant.accountId, before.buyer);
      await waitForFinal(async () => (await balances()).buyer === 0n);
    };
    try {
      const refused = await invoke(header(first));
      expect(refused.statusCode).toBe(402);
    } finally {
      duringBackend = undefined;
    }
    const [attempt] = await store.listPaymentAttempts({ limit: 1 });
    expect(attempt).toMatchObject({ status: 'rejected', rejectionReason: 'insufficient_funds' });
    expect(
      await finalNonceOf(buyer.accountId, buyer.keyPair.getPublicKey().toString()),
    ).toBeLessThan(nonceOf(first));

    await ftTransfer(merchant.accountId, merchant.keyPair, buyer.accountId, before.buyer);
    await expectBalances(before);
    // The nonce is still unused, so the client's next delegate repeats it
    const retry = await sign(await challenge());
    expect(nonceOf(retry)).toBe(nonceOf(first));
    const paid = await invoke(header(retry));

    expect(paid.statusCode).toBe(200);
    expect(backendCalls - calls).toBe(2);
    await expectBalances({ buyer: before.buyer - PRICE, merchant: before.merchant + PRICE });
  });

  it('a submission whose RPC response is lost is uncertain, never a rejection', async () => {
    const rpc = await startLossyRpc(sandbox.rpcUrl, 'send_tx');
    const lossyFacilitator = await startLoopbackFacilitator({
      near: {
        network: NETWORK,
        rpcUrl: rpc.url,
        relayer: { accountId: relayer.accountId, secretKey: relayer.secretKey },
      },
    });
    try {
      const provider = createX402PaymentProvider({
        network: NETWORK,
        rpcUrl: sandbox.rpcUrl,
        asset: NEAR_TESTNET_USDC,
        assetDecimals: 6,
        payTo: merchant.accountId,
        facilitator: { mode: 'remote', url: lossyFacilitator.url, auth: { type: 'none' } },
      });
      const resource = config.resources[0] as (typeof config.resources)[number];
      const requirement = await provider.createRequirement({
        requestId: 'req-lossy',
        resource,
        amount: '1.00',
        currency: 'USDC',
        requestedAt: new Date().toISOString(),
      });
      const proof = await sign(requirement.challenge.envelope as unknown as PaymentRequired);
      const context = {
        requestId: 'req-lossy',
        resource,
        requirement,
        submission: { method: 'x402' as const, payload: header(proof)['payment-signature'] },
      };
      const before = await balances();
      const verification = await provider.verify(context);
      expect(verification.status).toBe('verified');

      // The SDK reports the lost response as `settlement_failed` without a
      // hash, while the delegated transfer executes
      await expect(provider.settle({ ...context, verification })).rejects.toSatisfy(
        (err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
      );
      await expectBalances({ buyer: before.buyer - PRICE, merchant: before.merchant + PRICE });
    } finally {
      await lossyFacilitator.close();
      await rpc.close();
    }
  });

  it('fails health: the sandbox is not the chain its offer names', async () => {
    const provider = createConfiguredPaymentProviders(config.payments, NOOP_LOGGER)[0];
    const health = await provider?.health();
    expect(health?.status).toBe('fail');
    const status = await nearRpc<{ chain_id: string }>(sandbox.rpcUrl, 'status', []);
    expect(health?.detail).toContain(
      `serves chain ${status.chain_id}, expected testnet (NEAR Testnet)`,
    );
  });
});
