/**
 * The deterministic buyer demo. The chain manifest, MCP session, proof
 * construction, balance reads and output are injectable, so the whole flow,
 * failures included, runs in unit tests without a gateway, chain or network.
 *
 * No failed step is retried. It throws a `DemoAgentStepError` naming the step,
 * caught once at the top and turned into a non-zero exit code.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { formatUnits, parseUnits } from 'viem';
import {
  DELIVERY_SUMMARY_META_KEY,
  type DeliverySummary,
  isPaymentRequiredEnvelope,
  PAYMENT_INPUT_FIELD,
} from '../../../src/core';
import { LOCAL_NETWORK } from '../../../src/payments/x402/chain';
import { type BalanceReader, createBalanceReader } from './balances';
import { type LocalChainManifest, loadLocalChainManifest } from './chain-manifest';
import { createDemoLogger, type DemoLogger } from './log';
import { connectMcpSession, type McpSession } from './mcp-client';
import { type CreatePaymentProof, createPaymentProofDynamic } from './payment-client';
import { buildToolArguments, isPaidTool } from './tool-args';

export const DEFAULT_GATEWAY_URL = 'http://localhost:8080';

export class DemoAgentStepError extends Error {
  readonly step: string;
  constructor(step: string, message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DemoAgentStepError';
    this.step = step;
  }
}

export interface DemoAgentDeps {
  readonly logger?: DemoLogger;
  readonly gatewayUrl?: string;
  readonly loadManifest?: () => LocalChainManifest;
  readonly connectMcp?: (gatewayUrl: string) => Promise<McpSession>;
  readonly createPaymentProof?: CreatePaymentProof;
  readonly createBalanceReader?: (rpcUrl: string, asset: `0x${string}`) => BalanceReader;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DemoAgentStepError) throw err;
    throw new DemoAgentStepError(name, messageOf(err), { cause: err });
  }
}

/**
 * The most this demo agrees to pay, in the asset's smallest unit: ten times
 * the demo price of 0.01 USDC (10_000 units at 6 decimals). A challenge asking
 * for more is refused.
 */
export const MAX_DEMO_PAYMENT_UNITS = 100_000n;

/**
 * Refuses a payment requirement that does not match what the buyer intended.
 *
 * `createPaymentProof` signs whatever network, recipient, asset and amount the
 * server's 402 challenge names, so the buyer checks all four against its own
 * expectations before signing. The balance check after delivery compares the
 * delta with the same server-supplied amount, once the funds have moved, so it
 * cannot catch a hostile challenge. A real buyer must check the challenge the
 * same way.
 */
export function assertPaymentIsExpected(
  // `| undefined` because a challenge that omits a field must reach the
  // refusal, and under exactOptionalPropertyTypes `?:` alone does not admit it
  accepts: {
    payTo?: string | undefined;
    asset?: string | undefined;
    amount?: string | undefined;
    network?: string | undefined;
  },
  expected: { merchant: string; asset: string; maxValue: bigint; network: string },
): void {
  const step = 'check the payment requirement before signing';
  const same = (a: string | undefined, b: string): boolean =>
    typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

  // `createPaymentProof` derives the EIP-712 chain id from the network, so an
  // unpinned one lets a hostile gateway pick the chain the signature is for
  if (accepts.network !== expected.network) {
    throw new DemoAgentStepError(
      step,
      `challenge names network "${String(accepts.network)}" but the expected network is "${expected.network}"; refusing to sign`,
    );
  }
  if (!same(accepts.payTo, expected.merchant)) {
    throw new DemoAgentStepError(
      step,
      `challenge pays "${String(accepts.payTo)}" but the expected merchant is "${expected.merchant}"; refusing to sign`,
    );
  }
  if (!same(accepts.asset, expected.asset)) {
    throw new DemoAgentStepError(
      step,
      `challenge is denominated in "${String(accepts.asset)}" but the expected asset is "${expected.asset}"; refusing to sign`,
    );
  }
  let value: bigint;
  try {
    value = BigInt(accepts.amount ?? '');
  } catch {
    throw new DemoAgentStepError(
      step,
      `challenge amount "${String(accepts.amount)}" is not an integer; refusing to sign`,
    );
  }
  if (value <= 0n || value > expected.maxValue) {
    throw new DemoAgentStepError(
      step,
      `challenge asks for ${value} units, outside the accepted range (0, ${expected.maxValue}]; refusing to sign`,
    );
  }
}

/** Runs the full buyer flow. Returns the process exit code and never throws */
export async function runDemoAgent(deps: DemoAgentDeps = {}): Promise<number> {
  const log = deps.logger ?? createDemoLogger();
  const gatewayUrl = (deps.gatewayUrl ?? process.env['GATEWAY_URL'] ?? DEFAULT_GATEWAY_URL).replace(
    /\/$/,
    '',
  );
  const loadManifest = deps.loadManifest ?? loadLocalChainManifest;
  const connectMcp = deps.connectMcp ?? connectMcpSession;
  const createProof = deps.createPaymentProof ?? createPaymentProofDynamic;
  const makeBalanceReader = deps.createBalanceReader ?? createBalanceReader;

  let session: McpSession | undefined;
  try {
    log.agent('Agent Commerce Gateway: deterministic buyer demo');

    const manifest = await step('load local chain manifest (.deploy/local.json)', async () =>
      loadManifest(),
    );
    // `manifest.rpcUrl` is the deployer's endpoint; under docker compose it is
    // the container-only "http://anvil:8545". `hostRpcUrl` is the same chain as
    // the host reaches it. X402_RPC_URL wins, and a manifest without
    // hostRpcUrl falls back to rpcUrl.
    const rpcUrl = process.env['X402_RPC_URL'] ?? manifest.hostRpcUrl ?? manifest.rpcUrl;
    log.buyer(`address ${manifest.buyer.address} (${manifest.buyer.note})`);
    log.agent(`merchant ${manifest.merchant.address} (${manifest.merchant.privateKeyLabel})`);
    log.agent(`asset ${manifest.asset} (${manifest.assetName}) on ${rpcUrl}`);

    const balances = makeBalanceReader(rpcUrl, manifest.asset as `0x${string}`);
    const buyerBefore = await step('read buyer on-chain balance (before)', async () =>
      balances.read(manifest.buyer.address as `0x${string}`),
    );
    const merchantBefore = await step('read merchant on-chain balance (before)', async () =>
      balances.read(manifest.merchant.address as `0x${string}`),
    );
    log.buyer(
      `balance before  ${formatUnits(buyerBefore, manifest.assetDecimals)} ${manifest.assetName}`,
    );
    log.agent(
      `merchant balance before ${formatUnits(merchantBefore, manifest.assetDecimals)} ${manifest.assetName}`,
    );

    session = await step('connect to the gateway MCP endpoint', async () => connectMcp(gatewayUrl));
    log.gateway(`connected to ${gatewayUrl}/mcp`);

    const tools = await step(
      'list MCP tools',
      async () => session?.listTools() ?? Promise.resolve([]),
    );
    log.agent(
      `discovered ${tools.length} tool(s): ${tools.map((t) => t.name).join(', ') || '(none)'}`,
    );

    const paidTool = tools.find(isPaidTool);
    const freeTool = tools.find((t) => !isPaidTool(t));
    if (paidTool === undefined) {
      throw new DemoAgentStepError(
        'find a paid tool',
        'no tool requiring "_payment" was discovered',
      );
    }
    if (freeTool === undefined) {
      throw new DemoAgentStepError('find a free tool', 'no free tool was discovered');
    }
    log.agent(`paid tool: "${paidTool.name}", free tool: "${freeTool.name}"`);

    const unpaid = await step(`call "${paidTool.name}" with no payment proof`, async () =>
      requireSession(session).callTool(paidTool.name, buildToolArguments(paidTool)),
    );
    if (unpaid.isError !== true) {
      throw new DemoAgentStepError(
        `call "${paidTool.name}" with no payment proof`,
        `expected an isError response (PAYMENT_REQUIRED), delivery succeeded unpaid: ${summarize(unpaid)}`,
      );
    }
    const structured = unpaid.structuredContent;
    if (!isPaymentRequiredEnvelope(structured)) {
      throw new DemoAgentStepError(
        `call "${paidTool.name}" with no payment proof`,
        `expected a PaymentRequiredEnvelope, got: ${summarize(unpaid)}`,
      );
    }
    const envelope = structured;
    log.gateway(
      `402 payment required: ${envelope.payment.amount} ${envelope.payment.currency} to ${envelope.payment.destination}`,
    );

    const accepts = envelope.payment.accepts[0];
    if (accepts === undefined) {
      throw new DemoAgentStepError(
        'read payment requirement',
        'PaymentRequiredEnvelope.payment.accepts was empty',
      );
    }

    // Check the challenge before signing it (see assertPaymentIsExpected)
    assertPaymentIsExpected(accepts, {
      merchant: manifest.merchant.address,
      asset: manifest.asset,
      maxValue: MAX_DEMO_PAYMENT_UNITS,
      network: process.env['X402_NETWORK'] ?? LOCAL_NETWORK,
    });
    log.buyer(
      `challenge checked before signing: pays ${accepts.amount} units of ${accepts.asset} to ${accepts.payTo}`,
    );

    const proof = await step('build the x402 payment proof', async () =>
      createProof({
        buyerPrivateKey: manifest.buyer.privateKey as `0x${string}`,
        accepts,
      }),
    );
    log.buyer(`signed x402 payment proof (${manifest.buyer.note})`);

    const paid = await step(`retry "${paidTool.name}" with the payment proof`, async () =>
      requireSession(session).callTool(paidTool.name, {
        ...buildToolArguments(paidTool),
        [PAYMENT_INPUT_FIELD]: proof,
      }),
    );
    if (paid.isError === true) {
      throw new DemoAgentStepError(
        `retry "${paidTool.name}" with the payment proof`,
        `gateway rejected the paid call: ${summarize(paid)}`,
      );
    }
    log.gateway(`delivered "${paidTool.name}"`);

    const summary = readDeliverySummary(paid);
    logDeliverySummary(log, summary);

    const buyerAfter = await step('read buyer on-chain balance (after)', async () =>
      balances.read(manifest.buyer.address as `0x${string}`),
    );
    const merchantAfter = await step('read merchant on-chain balance (after)', async () =>
      balances.read(manifest.merchant.address as `0x${string}`),
    );
    log.buyer(
      `balance after   ${formatUnits(buyerAfter, manifest.assetDecimals)} ${manifest.assetName}  (Δ ${formatUnits(buyerAfter - buyerBefore, manifest.assetDecimals)})`,
    );
    log.agent(
      `merchant balance after  ${formatUnits(merchantAfter, manifest.assetDecimals)} ${manifest.assetName}  (Δ ${formatUnits(merchantAfter - merchantBefore, manifest.assetDecimals)})`,
    );

    const expectedDelta = parseUnits(envelope.payment.amount, manifest.assetDecimals);
    if (merchantAfter - merchantBefore !== expectedDelta) {
      throw new DemoAgentStepError(
        'verify settlement moved funds on-chain',
        `merchant balance changed by ${(merchantAfter - merchantBefore).toString()} base units, expected +${expectedDelta.toString()}`,
      );
    }
    if (buyerBefore - buyerAfter !== expectedDelta) {
      throw new DemoAgentStepError(
        'verify settlement moved funds on-chain',
        `buyer balance changed by -${(buyerBefore - buyerAfter).toString()} base units, expected -${expectedDelta.toString()}`,
      );
    }
    log.agent('on-chain balance changes match the expected payment amount');

    const free = await step(`call free tool "${freeTool.name}"`, async () =>
      requireSession(session).callTool(freeTool.name, buildToolArguments(freeTool)),
    );
    if (free.isError === true) {
      throw new DemoAgentStepError(
        `call free tool "${freeTool.name}"`,
        `gateway rejected the free call: ${summarize(free)}`,
      );
    }
    log.gateway(`delivered free tool "${freeTool.name}": ${summarize(free)}`);

    log.agent('demo complete: free and paid delivery both verified');
    return 0;
  } catch (err) {
    const stepName = err instanceof DemoAgentStepError ? err.step : 'unknown step';
    log.agent(`FAIL at step "${stepName}": ${messageOf(err)}`);
    return 1;
  } finally {
    if (session !== undefined) {
      await session.close().catch(() => {});
    }
  }
}

function requireSession(session: McpSession | undefined): McpSession {
  if (session === undefined) {
    throw new DemoAgentStepError('use the MCP session', 'MCP session was never established');
  }
  return session;
}

/**
 * Reads the payer-facing `DeliverySummary` from a delivered result's `_meta`
 * under `DELIVERY_SUMMARY_META_KEY`. Only a shape check: it proves the adapter
 * sent a summary, not that the summary is honest.
 */
function readDeliverySummary(result: CallToolResult): DeliverySummary {
  const raw = result._meta?.[DELIVERY_SUMMARY_META_KEY];
  if (raw === undefined || typeof raw !== 'object' || raw === null) {
    throw new DemoAgentStepError(
      'read delivery summary',
      `delivered result carried no "${DELIVERY_SUMMARY_META_KEY}" _meta, and the buyer has no ` +
        'other way to learn its receipt: it holds no admin token for /api/receipts',
    );
  }
  return raw as DeliverySummary;
}

function logDeliverySummary(log: DemoLogger, summary: DeliverySummary): void {
  const status = summary.payment?.status ?? 'unknown';
  const reference = summary.payment?.externalReference ?? '(none)';
  log.receipt(
    `id=${summary.receiptId} requestId=${summary.requestId} status=${status} settlementTx=${reference}`,
  );
}

function summarize(result: CallToolResult): string {
  const body = result.structuredContent ?? result.content;
  const text = JSON.stringify(body);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}
