/**
 * Solana `exact` settlement on `solana-test-validator`, signed by the SDK
 * client and served over HTTP by its facilitator. Solana uses the gateway's
 * remote path only. The validator holds a USDC-style mint at the devnet USDC
 * address and uses the devnet CAIP-2 id; the SDK accepts only known cluster
 * ids. Balances come from the validator's token accounts.
 */
import { generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentRequired } from '@x402/core/types';
import { ExactSvmScheme } from '@x402/svm/exact/client';
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
import { assertTransferOnChain } from '../../fixtures/x402/smoke/evidence';
import {
  associatedTokenAddress,
  isSolanaValidatorAvailable,
  mintAccount,
  type SolanaValidator,
  solanaRpc,
  startSolanaValidator,
  tokenAccount,
  tokenBalance,
  walletAccount,
} from '../../fixtures/x402/solana-validator';
import { withSignatureBytes } from '../../fixtures/x402/svm-transaction';

const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const RPC_PORT = 18899;
const RESOURCE_ID = 'market_report';
const PRICE = 1_000_000n;

const HAS_VALIDATOR = isSolanaValidatorAvailable();
if (!HAS_VALIDATOR && process.env['CI']) {
  throw new Error(
    'solana-test-validator is not on PATH, but CI is set. This suite settles on a ' +
      'local validator and must not be skipped in CI - install the Agave CLI in the job.',
  );
}
const describeWithValidator = HAS_VALIDATOR ? describe : describe.skip;

let validator: SolanaValidator;
let facilitator: LoopbackFacilitator;
let gateway: GatewayInstance;
let config: GatewayConfig;
let store: ReturnType<typeof createSqliteReceiptStore>;
let buyer: KeyPairSigner;
let feePayer: KeyPairSigner;
let merchant: string;
let backendCalls = 0;
// Holds a request between reservation and settlement, which follows the backend
let backendDelayMs = 0;

const backend: BackendExecutor = {
  async call() {
    backendCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, backendDelayMs));
    return { status: 200, body: { report: 'ok' }, headers: {}, durationMs: 1 };
  },
};

async function balances() {
  const [buyerBalance, merchantBalance] = await Promise.all([
    tokenBalance(validator.rpcUrl, await associatedTokenAddress(buyer.address, USDC)),
    tokenBalance(validator.rpcUrl, await associatedTokenAddress(merchant, USDC)),
  ]);
  return { buyer: buyerBalance, merchant: merchantBalance };
}

async function invoke(headers: Record<string, string> = {}) {
  return gateway.server.inject({
    method: 'POST',
    url: `/api/resources/${RESOURCE_ID}/invoke`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: {},
  });
}

type SvmProof = {
  accepted: Record<string, unknown>;
  payload: { transaction: string };
};

async function sign(offered: PaymentRequired): Promise<SvmProof> {
  const client = new x402Client();
  client.register(DEVNET, new ExactSvmScheme(buyer, { rpcUrl: validator.rpcUrl }));
  client.setSpendControls(false);
  return (await client.createPaymentPayload(offered)) as unknown as SvmProof;
}

async function challenge(): Promise<PaymentRequired> {
  const unpaid = await invoke();
  expect(unpaid.statusCode).toBe(402);
  return new x402HTTPClient(new x402Client()).getPaymentRequiredResponse(
    (name) => unpaid.headers[name.toLowerCase()] as string | undefined,
  );
}

const header = (proof: unknown) => ({
  'payment-signature': Buffer.from(JSON.stringify(proof)).toString('base64'),
});

async function waitForBalances(expected: { buyer: bigint; merchant: bigint }) {
  const deadline = Date.now() + 15_000;
  const settled = (b: { buyer: bigint; merchant: bigint }) =>
    b.buyer === expected.buyer && b.merchant === expected.merchant;
  let current = await balances();
  while (Date.now() < deadline && !settled(current)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    current = await balances();
  }
  expect(current).toEqual(expected);
}

beforeAll(async () => {
  if (!HAS_VALIDATOR) return;
  buyer = await generateKeyPairSigner();
  feePayer = await generateKeyPairSigner();
  merchant = (await generateKeyPairSigner()).address;
  validator = await startSolanaValidator({
    rpcPort: RPC_PORT,
    accounts: [
      mintAccount(USDC, 6, 100_000_000n),
      await tokenAccount(buyer.address, USDC, 100_000_000n),
      await tokenAccount(merchant, USDC, 0n),
      walletAccount(feePayer.address, 10n),
    ],
  });
  facilitator = await startLoopbackFacilitator({
    svm: { network: DEVNET, rpcUrl: validator.rpcUrl, feePayer },
  });
  config = parseConfig(
    {
      version: 1,
      merchant: { id: 'solana', name: 'Solana', publicBaseUrl: 'http://127.0.0.1:8080' },
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
          // The devnet USDC by default; the validator holds a mint at its address
          network: DEVNET,
          rpcUrl: validator.rpcUrl,
          payTo: merchant,
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
}, 120_000);

afterAll(async () => {
  await gateway?.close();
  await store?.close();
  await facilitator?.close();
  await validator?.stop();
});

describeWithValidator('x402 Solana settlement on a local validator', () => {
  it('settles an SDK-signed transaction and moves the token on chain', async () => {
    const offered = await challenge();
    expect(offered.accepts[0]?.extra?.['feePayer']).toBe(feePayer.address);
    const before = await balances();

    const paid = await invoke(header(await sign(offered)));
    expect(paid.statusCode).toBe(200);
    const settlement = new x402HTTPClient(new x402Client()).getPaymentSettleResponse(
      (name) => paid.headers[name.toLowerCase()] as string | undefined,
    );
    expect(settlement).toMatchObject({ success: true, network: DEVNET });

    // The signature names a confirmed transaction without an error
    const status = await solanaRpc<{
      value: { err: unknown; confirmationStatus: string }[];
    }>(validator.rpcUrl, 'getSignatureStatuses', [[settlement.transaction]]);
    expect(status.value[0]).toMatchObject({ err: null });
    expect(['confirmed', 'finalized']).toContain(status.value[0]?.confirmationStatus);
    await waitForBalances({ buyer: before.buyer - PRICE, merchant: before.merchant + PRICE });

    // The public-network smoke harness reads the token movement from the transaction itself
    const transfer = {
      asset: USDC,
      from: buyer.address,
      to: merchant,
      amount: PRICE,
      reference: settlement.transaction,
    };
    await assertTransferOnChain('svm', validator.rpcUrl, transfer);
    await expect(
      assertTransferOnChain('svm', validator.rpcUrl, { ...transfer, amount: PRICE + 1n }),
    ).rejects.toThrow(/payee's .* change/);

    const [receipt] = await store.listReceipts({ limit: 1 });
    expect(receipt?.payment).toMatchObject({
      network: DEVNET,
      externalReference: settlement.transaction,
      payer: buyer.address,
    });
  });

  it.each<[string, (offer: Record<string, unknown>) => void, string]>([
    [
      'another wallet',
      (offer) => {
        offer['payTo'] = 'Bz6TZb9AuDDrv1qATAoG3D4sRS9GZnBdfvVKJW5mo8Fr';
      },
      'invalid_exact_svm_payload_recipient_mismatch',
    ],
    [
      'a smaller amount',
      (offer) => {
        offer['amount'] = '1';
      },
      'invalid_exact_svm_payload_amount_mismatch',
    ],
  ])('refuses a transaction paying %s, moving nothing', async (_case, tamper, reason) => {
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

  it('settles one transaction once when presented on two requests at the same time', async () => {
    const proof = await sign(await challenge());
    const before = await balances();
    const calls = backendCalls;
    const statuses = (await Promise.all([invoke(header(proof)), invoke(header(proof))])).map(
      (response) => response.statusCode,
    );
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(backendCalls - calls).toBe(1);
    await waitForBalances({ buyer: before.buyer - PRICE, merchant: before.merchant + PRICE });
  });

  it('reserves the transaction, not its signature bytes, while the first copy is settling', async () => {
    const proof = await sign(await challenge());
    const altered = structuredClone(proof);
    altered.payload.transaction = withSignatureBytes(proof.payload.transaction, 0, 0xab);
    const before = await balances();
    backendDelayMs = 1_000;
    try {
      const [first, second] = await Promise.all([
        invoke(header(proof)),
        // After the first has reserved, before it settles
        new Promise((resolve) => setTimeout(resolve, 200)).then(() => invoke(header(altered))),
      ]);
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe('PAYMENT_REPLAYED');
    } finally {
      backendDelayMs = 0;
    }
    await waitForBalances({ buyer: before.buyer - PRICE, merchant: before.merchant + PRICE });
  });

  it('refuses a settled transaction presented again, moving nothing', async () => {
    const proof = await sign(await challenge());
    expect((await invoke(header(proof))).statusCode).toBe(200);
    const after = await balances();

    // The facilitator's simulation finds the transaction already processed
    proof.payload.transaction = withSignatureBytes(proof.payload.transaction, 0, 0xab);
    const replayed = await invoke(header(proof));
    expect(replayed.statusCode).toBe(402);
    expect(replayed.json().message).toBe('invalid_exact_svm_transaction_simulation_failed');
    expect(await balances()).toEqual(after);
  });

  it('a broadcast whose RPC response is lost is uncertain, never a rejection', async () => {
    const rpc = await startLossyRpc(validator.rpcUrl, 'sendTransaction');
    const lossyFacilitator = await startLoopbackFacilitator({
      svm: { network: DEVNET, rpcUrl: rpc.url, feePayer },
    });
    try {
      const provider = createX402PaymentProvider({
        network: DEVNET,
        rpcUrl: validator.rpcUrl,
        asset: USDC,
        assetDecimals: 6,
        payTo: merchant,
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

      // The SDK reports the lost response as its catch-all without a
      // signature, while the transfer lands
      await expect(provider.settle({ ...context, verification })).rejects.toSatisfy(
        (err: unknown) => isCommerceError(err) && err.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
      );
      await waitForBalances({ buyer: before.buyer - PRICE, merchant: before.merchant + PRICE });
    } finally {
      await lossyFacilitator.close();
      await rpc.close();
    }
  });

  it('fails health: the validator is not the devnet cluster its offer names', async () => {
    const provider = createConfiguredPaymentProviders(config.payments, NOOP_LOGGER)[0];
    const health = await provider?.health();
    expect(health?.status).toBe('fail');
    const genesis = await solanaRpc<string>(validator.rpcUrl, 'getGenesisHash', []);
    expect(health?.detail).toContain(
      `serves solana:${genesis.slice(0, 32)}, expected ${DEVNET} (Solana Devnet)`,
    );
  });
});
