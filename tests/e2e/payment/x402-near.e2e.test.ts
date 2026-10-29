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
import {
  type BackendExecutor,
  isCommerceError,
  NOOP_LOGGER,
  type PaymentAttempt,
  type PaymentProvider,
  type PaymentReconciliationResult,
} from '../../../src/core';
import { createGateway, type GatewayInstance } from '../../../src/gateway';
import { createConfiguredPaymentProviders } from '../../../src/gateway/payment-providers';
import { createX402PaymentProvider } from '../../../src/payments/x402';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import { locatorOf } from '../../fixtures/x402/locator';
import {
  type LoopbackFacilitator,
  startLoopbackFacilitator,
} from '../../fixtures/x402/loopback-facilitator';
import { type RecordingRpc, startLossyRpc, startRecordingRpc } from '../../fixtures/x402/lossy-rpc';
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
import { assertTransferOnChain } from '../../fixtures/x402/smoke/evidence';

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
    paymentProviders: await createConfiguredPaymentProviders(config.payments, NOOP_LOGGER),
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

    // The public-network smoke harness reads the ft_transfer from the transaction's receipts
    const transfer = {
      asset: NEAR_TESTNET_USDC,
      from: buyer.accountId,
      to: merchant.accountId,
      amount: PRICE,
      reference: settlement.transaction,
    };
    await assertTransferOnChain('near', sandbox.rpcUrl, transfer, [relayer.accountId]);
    await expect(
      assertTransferOnChain('near', sandbox.rpcUrl, { ...transfer, amount: PRICE + 1n }, [
        relayer.accountId,
      ]),
    ).rejects.toThrow(/no ft_transfer of/);

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
    const provider = (await createConfiguredPaymentProviders(config.payments, NOOP_LOGGER))[0];
    const health = await provider?.health();
    expect(health?.status).toBe('fail');
    const status = await nearRpc<{ chain_id: string }>(sandbox.rpcUrl, 'status', []);
    expect(health?.detail).toContain(
      `serves chain ${status.chain_id}, expected testnet (NEAR Testnet)`,
    );
  });
});

async function finalHeight(): Promise<bigint> {
  const block = await nearRpc<{ header: { height: number } }>(sandbox.rpcUrl, 'block', {
    finality: 'final',
  });
  return BigInt(block.header.height);
}

// Build a buyer delegate expiring `blocks` above the final height
async function delegateProof(
  offered: PaymentRequired,
  options: { keyPair?: KeyPair; blocks: bigint },
) {
  const keyPair = options.keyPair ?? buyer.keyPair;
  const nonce = (await finalNonceOf(buyer.accountId, keyPair.getPublicKey().toString())) + 1n;
  const { signedDelegateAction } = await buildSignedDelegate({
    keyPair,
    senderId: buyer.accountId,
    receiverId: NEAR_TESTNET_USDC,
    ftReceiver: merchant.accountId,
    amount: PRICE.toString(),
    nonce,
    maxBlockHeight: (await finalHeight()) + options.blocks,
  });
  return { x402Version: 2, accepted: offered.accepts[0], payload: { signedDelegateAction } };
}

interface VerifiedPayment {
  readonly context: Parameters<PaymentProvider['settle']>[0];
  readonly locator: Readonly<Record<string, unknown>>;
  readonly attempt: PaymentAttempt;
}

// Build a verified payment and attempt data, using the SDK signer by default.
// Pass `build` to supply a custom proof.
async function verifiedPayment(
  provider: PaymentProvider,
  build: (offered: PaymentRequired) => Promise<unknown> = sign,
): Promise<VerifiedPayment> {
  const resource = config.resources[0] as (typeof config.resources)[number];
  const requestId = `req-${Math.random().toString(36).slice(2)}`;
  const createdAt = new Date().toISOString();
  const requirement = await provider.createRequirement({
    requestId,
    resource,
    amount: '1.00',
    currency: 'USDC',
    requestedAt: createdAt,
  });
  const proof = await build(requirement.challenge.envelope as unknown as PaymentRequired);
  const context = {
    requestId,
    resource,
    requirement,
    submission: { method: 'x402' as const, payload: header(proof)['payment-signature'] },
  };
  const verification = await provider.verify(context);
  expect(verification.status).toBe('verified');
  return {
    context: { ...context, verification },
    locator: locatorOf(verification),
    attempt: {
      id: `pa_${requestId}`,
      requestId,
      resourceId: resource.id,
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

function reconcile(
  provider: PaymentProvider,
  payment: VerifiedPayment,
  attempt: Partial<PaymentAttempt> = {},
): Promise<PaymentReconciliationResult> {
  const read = provider.reconcile;
  if (read === undefined) throw new Error('the provider has no reconcile');
  return read({
    attempt: { ...payment.attempt, ...attempt },
    locator: payment.locator,
    now: new Date().toISOString(),
  });
}

describeWithSandbox('x402 NEAR reconciliation on a local sandbox', () => {
  let rpc: RecordingRpc;
  let provider: PaymentProvider;

  beforeAll(async () => {
    // Report the offer's testnet chain ID so these cases reach evidence checks
    rpc = await startRecordingRpc(sandbox.rpcUrl, {
      status: (result) => ({ ...(result as object), chain_id: 'testnet' }),
    });
    provider = createX402PaymentProvider({
      network: NETWORK,
      rpcUrl: rpc.url,
      asset: NEAR_TESTNET_USDC,
      assetDecimals: 6,
      payTo: merchant.accountId,
      facilitator: { mode: 'remote', url: facilitator.url, auth: { type: 'none' } },
    });
  });

  afterAll(async () => {
    await rpc?.close();
  });

  // Settles a payment through `provider` and waits for its final status
  async function settledHash(payment: VerifiedPayment): Promise<string> {
    const settled = await provider.settle(payment.context);
    expect(settled.status).toBe('settled');
    const hash = settled.externalReference as string;
    await waitForFinal(
      async () =>
        (
          await nearRpc<{ final_execution_status: string }>(
            sandbox.rpcUrl,
            'EXPERIMENTAL_tx_status',
            { tx_hash: hash, sender_account_id: relayer.accountId, wait_until: 'NONE' },
          )
        ).final_execution_status === 'FINAL',
    );
    return hash;
  }

  it('resolves settled from the relayer transaction, looked up with the relayer as sender', async () => {
    const payment = await verifiedPayment(provider);
    expect(payment.locator['relayers']).toEqual([relayer.accountId]);
    const hash = await settledHash(payment);
    const [calls, requests] = [rpc.calls.length, facilitator.requests.length];

    expect(await reconcile(provider, payment, { externalReference: hash })).toEqual({
      outcome: 'settled',
      reason: 'transfer_final',
      externalReference: hash,
      evidence: { transactionHash: hash, relayer: relayer.accountId },
    });
    // Check that the transaction lookup uses the relayer's account ID
    expect(rpc.calls.slice(calls)).toEqual([
      { method: 'status', params: [] },
      {
        method: 'EXPERIMENTAL_tx_status',
        params: { tx_hash: hash, sender_account_id: relayer.accountId, wait_until: 'NONE' },
      },
    ]);
    expect(facilitator.requests.slice(requests)).toEqual([]);
  });

  it("does not take another delegate's transaction as proof", async () => {
    const otherHash = await settledHash(await verifiedPayment(provider));
    const payment = await verifiedPayment(provider);

    expect(await reconcile(provider, payment, { externalReference: otherHash })).toEqual({
      outcome: 'unknown',
      reason: 'not_expired',
      evidence: {
        maxBlockHeight: payment.locator['maxBlockHeight'],
        keyNonce: expect.any(String),
        finalBlock: expect.any(String),
      },
    });
  });

  it('resolves not-settled once the final block passes maxBlockHeight with the nonce unused', async () => {
    const payment = await verifiedPayment(provider, (offered) =>
      delegateProof(offered, { blocks: 10n }),
    );
    const nonce = BigInt(payment.locator['nonce'] as string);
    const maxBlockHeight = BigInt(payment.locator['maxBlockHeight'] as string);
    expect(await reconcile(provider, payment)).toMatchObject({
      outcome: 'unknown',
      reason: 'not_expired',
    });

    await waitForFinal(async () => (await finalHeight()) > maxBlockHeight);
    const result = await reconcile(provider, payment);
    expect(result).toEqual({
      outcome: 'not-settled',
      reason: 'expired_unused',
      evidence: { keyNonce: String(nonce - 1n), finalBlock: expect.any(String) },
    });
    expect(BigInt(result.evidence?.['finalBlock'] as string)).toBeGreaterThan(maxBlockHeight);
  });

  it('leaves a delegate unknown when another transaction used its nonce', async () => {
    const payment = await verifiedPayment(provider);
    const nonce = BigInt(payment.locator['nonce'] as string);
    // A transaction signed by the same key advances its nonce
    await sandbox
      .account(buyer.accountId, buyer.keyPair)
      .addFullAccessKey(KeyPair.fromRandom('ed25519').getPublicKey());
    const publicKey = buyer.keyPair.getPublicKey().toString();
    await waitForFinal(async () => (await finalNonceOf(buyer.accountId, publicKey)) >= nonce);

    expect(await reconcile(provider, payment)).toEqual({
      outcome: 'unknown',
      reason: 'used_without_record',
      evidence: {
        keyNonce: String(await finalNonceOf(buyer.accountId, publicKey)),
        finalBlock: expect.any(String),
      },
    });
  });

  it('leaves a delegate unknown when its access key was deleted', async () => {
    const spare = KeyPair.fromRandom('ed25519');
    const account = sandbox.account(buyer.accountId, buyer.keyPair);
    await account.addFullAccessKey(spare.getPublicKey());
    const publicKey = spare.getPublicKey().toString();
    await waitForFinal(async () => (await finalNonceOf(buyer.accountId, publicKey)) > 0n);
    const payment = await verifiedPayment(provider, (offered) =>
      delegateProof(offered, { keyPair: spare, blocks: 30n }),
    );
    await account.deleteKey(spare.getPublicKey());
    await waitForFinal(async () => {
      const key = await nearRpc<{ error?: string }>(sandbox.rpcUrl, 'query', {
        request_type: 'view_access_key',
        finality: 'final',
        account_id: buyer.accountId,
        public_key: publicKey,
      });
      return key.error !== undefined;
    });

    expect(await reconcile(provider, payment)).toEqual({
      outcome: 'unknown',
      reason: 'access_key_missing',
      evidence: { finalBlock: expect.any(String) },
    });
  });

  it('answers chain_mismatch when the RPC is not the chain the locator names', async () => {
    const direct = createX402PaymentProvider({
      network: NETWORK,
      rpcUrl: sandbox.rpcUrl,
      asset: NEAR_TESTNET_USDC,
      assetDecimals: 6,
      payTo: merchant.accountId,
      facilitator: { mode: 'remote', url: facilitator.url, auth: { type: 'none' } },
    });
    const payment = await verifiedPayment(direct);
    const status = await nearRpc<{ chain_id: string }>(sandbox.rpcUrl, 'status', []);

    expect(await reconcile(direct, payment)).toEqual({
      outcome: 'unknown',
      reason: 'chain_mismatch',
      evidence: { chainId: status.chain_id, expectedChainId: 'testnet' },
    });
  });
});
