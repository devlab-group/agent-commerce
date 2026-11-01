/**
 * Restores a backup taken between purchases on local Anvil. Replaying the
 * recorded settled and uncertain payments, or a payment made after the backup,
 * moves no funds. `reconcile` then resolves the restored uncertain attempt.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestClient, http } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runBackupCommand } from '../../../src/cli/commands/backup';
import { runReconcileCommand } from '../../../src/cli/commands/reconcile';
import { type GatewayConfig, parseConfig } from '../../../src/config';
import { type BackendExecutor, NOOP_LOGGER, PAYMENT_HEADER } from '../../../src/core';
import { createGateway } from '../../../src/gateway';
import { createConfiguredPaymentProviders } from '../../../src/gateway/payment-providers';
import { createPaymentProof } from '../../../src/payments/x402';
import { type AnvilHandle, deployLocalChain, startAnvil } from '../../../src/payments/x402/testing';
import { createSqliteReceiptStore } from '../../../src/storage/receipts';
import { dumpTables } from '../../fixtures/sqlite-dump';
import {
  type LoopbackFacilitator,
  startLoopbackFacilitator,
} from '../../fixtures/x402/loopback-facilitator';
import { readBalances, waitForBalances } from '../../fixtures/x402/settlement';
import { createCapturingIo } from '../../unit/cli/fixtures';

const PORT = 18799;
const NETWORK = 'eip155:31337';
const ONE_USDC = 1_000_000n;
// Mine past Anvil's finality lag, as in the reconciliation E2E tests
const FINALITY_BLOCKS = 65;

const BACKEND: BackendExecutor = {
  async call() {
    return { status: 200, body: { report: 'ok' }, headers: {}, durationMs: 1 };
  },
};

let anvil: AnvilHandle;
let deployment: Awaited<ReturnType<typeof deployLocalChain>>;
let facilitator: LoopbackFacilitator;
let rpc: { url: string; lose: boolean; close(): Promise<void> };
let dir: string;

// Forward to Anvil; when `lose` is set, replace the broadcast response with
// an error after the transfer lands, hiding its outcome from the facilitator
async function startSwitchableRpc(upstream: string): Promise<typeof rpc> {
  const state = { lose: false };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const text = await (
      await fetch(upstream, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
    ).text();
    const call = JSON.parse(body) as { id?: unknown; method?: string };
    response.setHeader('content-type', 'application/json');
    response.end(
      state.lose && call.method === 'eth_sendRawTransaction'
        ? JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32603, message: 'reset' } })
        : text,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get lose() {
      return state.lose;
    },
    set lose(value: boolean) {
      state.lose = value;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

beforeAll(async () => {
  anvil = await startAnvil({ port: PORT, silent: true });
  deployment = await deployLocalChain({ rpcUrl: anvil.rpcUrl, buyerInitialBalance: '100.00' });
  rpc = await startSwitchableRpc(anvil.rpcUrl);
  facilitator = await startLoopbackFacilitator({
    evm: {
      chains: [{ network: NETWORK, rpcUrl: rpc.url }],
      signerPrivateKey: deployment.facilitator.privateKey,
    },
  });
  dir = mkdtempSync(join(tmpdir(), 'oac-restore-e2e-'));
}, 120_000);

afterAll(async () => {
  await facilitator?.close();
  await rpc?.close();
  await anvil?.stop();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

function config(receipts: string): GatewayConfig {
  return parseConfig(
    {
      version: 1,
      merchant: { id: 'restore-e2e', name: 'Restore E2E', publicBaseUrl: 'http://127.0.0.1:8080' },
      server: { port: 8080, host: '127.0.0.1', allowedOrigins: [] },
      storage: { receipts: { driver: 'sqlite', path: receipts } },
      protocols: { http: { enabled: true }, mcp: { enabled: false, mountPath: '/mcp' } },
      resources: {
        report: {
          name: 'Report',
          backend: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
          pricing: { type: 'fixed', amount: '1.00', currency: 'USDC' },
          expose: ['http'],
          payments: ['x402'],
        },
      },
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
          facilitator: { mode: 'remote', url: facilitator.url, auth: { type: 'none' } },
        },
      },
    },
    {},
  );
}

async function openGateway(cfg: GatewayConfig) {
  const store = createSqliteReceiptStore({ path: cfg.storage.receipts.path });
  await store.init();
  const gateway = await createGateway({
    config: cfg,
    store,
    paymentProviders: await createConfiguredPaymentProviders(cfg.payments, NOOP_LOGGER),
    protocolAdapters: [],
    backend: BACKEND,
  });
  const invoke = (headers: Record<string, string> = {}) =>
    gateway.server.inject({
      method: 'POST',
      url: '/api/resources/report/invoke',
      headers: { 'content-type': 'application/json', ...headers },
      payload: {},
    });
  // A fresh proof for the challenge the gateway issues now
  const proof = async () => {
    const challenge = await invoke();
    expect(challenge.statusCode).toBe(402);
    return createPaymentProof({
      buyerPrivateKey: deployment.buyer.privateKey,
      accepts: (challenge.json().payment as { accepts: Record<string, unknown>[] })
        .accepts[0] as Record<string, unknown>,
    });
  };
  return {
    invoke,
    proof,
    async close() {
      await gateway.close();
      await store.close();
    },
  };
}

describe('restoring a backup', () => {
  it('refuses the proofs it recorded, pays nothing twice, and reconcile resolves the uncertain attempt', async () => {
    const receipts = join(dir, 'receipts.sqlite');
    const cfg = config(receipts);
    const balanceQuery = {
      rpcUrl: anvil.rpcUrl,
      asset: deployment.asset,
      buyer: deployment.buyer.address,
      merchant: deployment.merchant.address,
    };
    const start = await readBalances(balanceQuery);

    const live = await openGateway(cfg);
    const settledProof = await live.proof();
    expect((await live.invoke({ [PAYMENT_HEADER]: settledProof })).statusCode).toBe(200);
    rpc.lose = true;
    const uncertainProof = await live.proof();
    const uncertain = await live.invoke({ [PAYMENT_HEADER]: uncertainProof });
    rpc.lose = false;
    expect(uncertain.json()).toMatchObject({ details: { settlementUncertain: true } });

    // Taken while the gateway runs
    const out = join(dir, 'backup');
    const backupIo = createCapturingIo();
    expect(await runBackupCommand({ out }, backupIo, { loadConfig: async () => cfg })).toBe(0);

    const laterProof = await live.proof();
    expect((await live.invoke({ [PAYMENT_HEADER]: laterProof })).statusCode).toBe(200);
    await live.close();
    const paid = await waitForBalances(
      balanceQuery,
      (snapshot) => start.buyer - snapshot.buyer === 3n * ONE_USDC,
      30_000,
    );

    // With the gateway stopped, remove the database and its WAL sidecars,
    // then restore the backup
    for (const file of [receipts, `${receipts}-wal`, `${receipts}-shm`]) {
      if (existsSync(file)) unlinkSync(file);
    }
    copyFileSync(join(out, 'receipts.sqlite'), receipts);
    const attempts = () =>
      (dumpTables(receipts).payment_attempts as { status: string }[]).map((row) => row.status);
    expect(attempts()).toEqual(['settled', 'settlement-uncertain']);

    const restored = await openGateway(cfg);
    try {
      // Every nonce is spent on chain, so verification refuses all three with a
      // fresh challenge before the replay key is checked. The last proof is
      // not in the backup and reaches the facilitator again.
      for (const proof of [settledProof, uncertainProof, laterProof]) {
        const replay = await restored.invoke({ [PAYMENT_HEADER]: proof });
        expect(replay.statusCode).toBe(402);
        expect(replay.json()).toMatchObject({ code: 'PAYMENT_INVALID' });
      }
    } finally {
      await restored.close();
    }
    expect(await readBalances(balanceQuery)).toEqual(paid);

    await createTestClient({ mode: 'anvil', transport: http(anvil.rpcUrl) }).mine({
      blocks: FINALITY_BLOCKS,
    });
    const io = createCapturingIo();
    expect(
      await runReconcileCommand({ json: true, actor: 'restore-e2e' }, io, {
        loadConfig: async () => cfg,
      }),
    ).toBe(0);
    const report = JSON.parse(io.out.join('\n')) as {
      entries: { outcome: string; written: boolean }[];
    };
    expect(report.entries).toEqual([
      expect.objectContaining({ outcome: 'settled', written: true }),
    ]);
    expect(attempts()).toEqual(['settled', 'settled']);
  });
});
