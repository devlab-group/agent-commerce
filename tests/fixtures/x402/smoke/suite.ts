/**
 * Runs each target through its own gateway using the config loader and SDK
 * buyer client. Pays once, checks chain evidence, response and receipt, then
 * verifies that replay does not deliver twice.
 */
import { appendFileSync } from 'node:fs';
import type { KeyPairString } from '@near-js/crypto';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentRequired } from '@x402/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../../../src/config';
import {
  isCommerceError,
  type Logger,
  type PaymentProvider,
  type ReceiptStore,
} from '../../../../src/core';
import { createGateway, type GatewayInstance } from '../../../../src/gateway';
import { createConfiguredPaymentProviders } from '../../../../src/gateway/payment-providers';
import { createSqliteReceiptStore } from '../../../../src/storage/receipts';
import { type LoopbackFacilitator, startLoopbackFacilitator } from '../loopback-facilitator';
import { buyerIdentity, signPayment } from './buyers';
import {
  assertTransferOnChain,
  buyerBalance,
  nearFullAccessKey,
  permit2Allowance,
  solanaPayeeAccount,
} from './evidence';
import { loopbackCertificate, trustLoopback } from './loopback-tls';
import { planSmoke, type SmokeKind, type SmokeSettings, type SmokeTarget } from './targets';

const RESOURCE_ID = 'smoke_report';
const SETTLE_TIMEOUT_MS = 600_000;

type FacilitatorAuth = Extract<SmokeSettings['facilitator'], { type: 'remote' }>['auth'];

// What an operator writes for this target: the network's default USDC and a USD price
function smokeConfig(
  target: SmokeTarget,
  settings: SmokeSettings,
  facilitator: { readonly url: string; readonly auth: FacilitatorAuth },
  allowMainnet = true,
): Record<string, unknown> {
  return {
    version: 1,
    merchant: {
      id: `${target.id}-smoke`,
      name: `${target.id} smoke test`,
      publicBaseUrl: 'http://127.0.0.1:8080',
    },
    server: { port: 8080, host: '127.0.0.1', allowedOrigins: [] },
    storage: { receipts: { driver: 'sqlite', path: ':memory:' } },
    protocols: { http: { enabled: true }, mcp: { enabled: false, mountPath: '/mcp' } },
    resources: {
      [RESOURCE_ID]: {
        name: 'Smoke report',
        backend: { type: 'http', method: 'GET', url: 'http://merchant.invalid/api/report' },
        pricing: { type: 'fixed', amount: settings.amount, currency: 'USD' },
        expose: ['http'],
        payments: ['x402'],
      },
    },
    payments: {
      x402: {
        enabled: true,
        network: target.network,
        payTo: settings.payTo,
        ...(target.assetTransferMethod !== undefined
          ? { assetTransferMethod: target.assetTransferMethod }
          : {}),
        networks: { [target.network]: { rpcUrl: settings.rpcUrl } },
        maxTimeoutSeconds: target.kind === 'mainnet' ? 600 : 300,
        facilitator: { mode: 'remote', url: facilitator.url, auth: facilitator.auth },
        ...(target.kind === 'mainnet'
          ? {
              ...(allowMainnet ? { allowMainnet: true } : {}),
              // Acknowledges a facilitator without a credential; ignored with one
              allowUnauthenticatedFacilitator: true,
            }
          : {}),
      },
    },
  };
}

// The accounts a NEAR facilitator relays from, which a transaction lookup needs
async function nearRelayers(url: string, network: string): Promise<string[]> {
  const response = await fetch(`${url.replace(/\/$/, '')}/supported`);
  const body = (await response.json()) as { signers?: Record<string, string[]> };
  const relayers = [...(body.signers?.[network] ?? []), ...(body.signers?.['near:*'] ?? [])];
  if (relayers.length === 0) {
    throw new Error(`the facilitator lists no NEAR relayer, so its transactions cannot be read`);
  }
  return relayers;
}

const sameAccount = (target: SmokeTarget, a: string, b: string) =>
  target.family === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b;

function defineTarget(kind: SmokeKind, target: SmokeTarget, settings: SmokeSettings): void {
  describe(`${target.id} (${target.network})`, () => {
    let gateway: GatewayInstance;
    let store: ReceiptStore;
    let provider: PaymentProvider;
    let selfHosted: LoopbackFacilitator | undefined;
    let restoreFetch: (() => void) | undefined;
    let facilitator: { url: string; auth: FacilitatorAuth };
    let nearSenders: readonly string[] = [];
    let buyer: string;
    let backendCalls = 0;
    // Everything the gateway logged, for the credential check
    const logged: string[] = [];

    const invoke = (headers: Record<string, string> = {}) =>
      gateway.server.inject({
        method: 'POST',
        url: `/api/resources/${RESOURCE_ID}/invoke`,
        headers: { 'content-type': 'application/json', ...headers },
        payload: {},
      });

    beforeAll(async () => {
      buyer = await buyerIdentity(target, settings);
      if (settings.facilitator.type === 'self-hosted-near') {
        const tls = loopbackCertificate();
        selfHosted = await startLoopbackFacilitator({
          tls,
          near: {
            network: target.network,
            rpcUrl: settings.rpcUrl,
            relayer: {
              accountId: settings.facilitator.relayerAccount,
              secretKey: settings.facilitator.relayerKey as KeyPairString,
            },
          },
        });
        restoreFetch = trustLoopback(new URL(selfHosted.url).origin, tls.cert);
        facilitator = { url: selfHosted.url, auth: { type: 'none' } };
        nearSenders = [settings.facilitator.relayerAccount];
      } else {
        facilitator = { url: settings.facilitator.url, auth: settings.facilitator.auth };
        if (target.family === 'near')
          nearSenders = await nearRelayers(facilitator.url, target.network);
      }

      const capture = (line: unknown, ...rest: unknown[]): void => {
        logged.push(JSON.stringify([line, ...rest]));
      };
      const makeLogger = (): Logger => ({
        debug: capture,
        info: capture,
        warn: capture,
        error: capture,
        child: () => makeLogger(),
      });
      const logger = makeLogger();

      const config = parseConfig(smokeConfig(target, settings, facilitator), {});
      store = createSqliteReceiptStore({ path: ':memory:' });
      await store.init();
      const providers = await createConfiguredPaymentProviders(config.payments, logger);
      provider = providers[0] as PaymentProvider;
      gateway = await createGateway({
        config,
        store,
        logger,
        paymentProviders: providers,
        protocolAdapters: [],
        // Stubbed: the suite asks whether money moved, and the offline suites
        // cover the HTTP backend
        backend: {
          call: async () => {
            backendCalls += 1;
            return { status: 200, headers: {}, body: { report: target.id }, durationMs: 1 };
          },
        },
      });
    }, 180_000);

    afterAll(async () => {
      await gateway?.close();
      await store?.close();
      await selfHosted?.close();
      restoreFetch?.();
    });

    if (kind === 'mainnet') {
      it('refuses the same config without allowMainnet', () => {
        try {
          parseConfig(smokeConfig(target, settings, facilitator, false), {});
          expect.unreachable('a mainnet config without allowMainnet must be refused');
        } catch (err) {
          expect(isCommerceError(err) && err.code).toBe('CONFIG_INVALID');
          expect(String((err as Error).message)).toContain('allowMainnet');
        }
      });
    }

    it(`reports a ${kind} deployment and passes its health check`, async () => {
      const res = await gateway.server.inject({
        method: 'GET',
        url: '/.well-known/agent-commerce',
      });
      const x402 = res.json().payments.x402;
      expect(x402).toMatchObject({ mode: kind, network: target.network });
      expect(x402.facilitator).toEqual({ mode: 'remote' });
      expect(res.payload).not.toContain(new URL(facilitator.url).host);
      // Chain id, token and facilitator support, before any money moves
      const health = await provider.health();
      expect(health.status, `health check failed: ${health.detail}`).toBe('pass');
    }, 120_000);

    it(
      'settles once, proven on chain, and delivers once',
      async () => {
        // 1. The unpaid request gets the challenge
        const unpaid = await invoke();
        expect(unpaid.statusCode).toBe(402);
        const offered: PaymentRequired = new x402HTTPClient(
          new x402Client(),
        ).getPaymentRequiredResponse((name) => unpaid.headers[name.toLowerCase()] as string);
        const offer = offered.accepts[0];
        if (offer === undefined) throw new Error('the challenge lists no offer');
        expect(offer.network).toBe(target.network);
        expect(sameAccount(target, offer.payTo, settings.payTo)).toBe(true);
        const amount = BigInt(offer.amount);

        // 2. Preconditions that would otherwise surface as an opaque refusal
        const held = await buyerBalance(target.family, settings.rpcUrl, offer.asset, buyer);
        expect(
          held >= amount,
          `buyer ${buyer} holds ${held} of ${offer.asset}, needs ${amount}`,
        ).toBe(true);
        if (target.family === 'svm') {
          const payee = await solanaPayeeAccount(settings.rpcUrl, offer.asset, settings.payTo);
          expect(
            payee,
            `${settings.payTo} has no token account for ${offer.asset}; send it any amount first`,
          ).toBeDefined();
        }
        if (target.family === 'near') {
          expect(
            await nearFullAccessKey(settings.rpcUrl, buyer, settings.buyerKey as KeyPairString),
            `the buyer key is not a full-access key of ${buyer}, or the account does not exist`,
          ).toBe(true);
        }
        if (target.assetTransferMethod === 'permit2') {
          const allowance = await permit2Allowance(settings.rpcUrl, offer.asset, buyer);
          expect(
            allowance >= amount,
            `buyer ${buyer} has not approved Permit2 for ${offer.asset}; approve it once, then rerun`,
          ).toBe(true);
        }

        // 3. The buyer pays, and the gateway settles through the facilitator
        const header = { 'payment-signature': await signPayment(target, settings, offered) };
        const paid = await invoke(header);
        expect(paid.statusCode, `the gateway refused the payment: ${paid.payload}`).toBe(200);
        expect(paid.json()).toEqual({ report: target.id });
        const settlement = new x402HTTPClient(new x402Client()).getPaymentSettleResponse(
          (name) => paid.headers[name.toLowerCase()] as string,
        );
        expect(settlement).toMatchObject({ success: true, network: target.network });
        if (settlement.payer !== undefined) {
          expect(sameAccount(target, settlement.payer, buyer)).toBe(true);
        }

        // 4. The chain, not the response, proves the transfer
        await assertTransferOnChain(
          target.family,
          settings.rpcUrl,
          {
            asset: offer.asset,
            from: buyer,
            to: offer.payTo,
            amount,
            reference: settlement.transaction,
          },
          nearSenders,
        );

        // 5. The receipt names the settlement
        const settled = (await store.listReceipts()).filter(
          (receipt) => receipt.payment?.externalReference === settlement.transaction,
        );
        expect(settled).toHaveLength(1);
        expect(settled[0]?.payment).toMatchObject({ status: 'settled', network: target.network });
        expect(settled[0]?.backendStatus).toBe(200);

        // 6. The same payment again moves nothing and delivers nothing
        const replay = await invoke(header);
        expect([402, 409]).toContain(replay.statusCode);
        expect(backendCalls).toBe(1);
        expect(
          (await store.listReceipts()).filter(
            (receipt) => receipt.payment?.externalReference === settlement.transaction,
          ),
        ).toHaveLength(1);

        // 7. A record of what ran, without secrets
        const record = {
          target: target.id,
          network: target.network,
          family: target.family,
          method: target.family === 'evm' ? (target.assetTransferMethod ?? 'eip3009') : 'exact',
          asset: offer.asset,
          amount: amount.toString(),
          payer: buyer,
          payTo: offer.payTo,
          facilitator:
            settings.facilitator.type === 'remote'
              ? new URL(facilitator.url).origin
              : 'self-hosted (SDK facilitator in this run)',
          reference: settlement.transaction,
          explorer: target.explorer(settlement.transaction),
          receipt: settled[0]?.id,
          at: new Date().toISOString(),
        };
        console.log(`[${kind}] evidence ${JSON.stringify(record)}`);
        const evidenceFile = process.env['X402_SMOKE_EVIDENCE_FILE'];
        if (evidenceFile) appendFileSync(evidenceFile, `${JSON.stringify(record)}\n`);
      },
      SETTLE_TIMEOUT_MS,
    );

    it('never logged a key or a credential', () => {
      const haystack = logged.join('\n');
      for (const secret of settings.secrets) expect(haystack).not.toContain(secret);
    });
  });
}

/**
 * Defines the x402 suite for testnets or mainnets. Problems with the requested
 * targets fail it before anything is spent; with nothing to run it skips and
 * names what each target needs.
 */
export function defineSmokeSuite(kind: SmokeKind): void {
  const plan = planSmoke(kind, process.env);
  if (plan.errors.length > 0) {
    describe(`x402 ${kind} smoke`, () => {
      it('has every setting the requested targets need, within the spend caps', () => {
        throw new Error(plan.errors.join('\n'));
      });
    });
    return;
  }
  if (plan.skipped.length > 0) {
    const needs = plan.skipped.map(({ id, missing }) => `${id} needs ${missing.join(', ')}`);
    console.log(`[${kind}] x402 smoke targets skipped: ${needs.join('; ')}`);
  }
  if (plan.run.length === 0) {
    describe.skip(`x402 ${kind} smoke`, () => {
      it('settles on a public network', () => {});
    });
    return;
  }
  for (const { target, settings } of plan.run) defineTarget(kind, target, settings);
}
