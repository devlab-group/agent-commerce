/**
 * The deterministic buyer demo.
 *
 * Every external effect (chain manifest, MCP session, payment-proof
 * construction, balance reads, receipt lookup, output) is injected, so the
 * whole flow — happy path and every failure step — is unit-testable without
 * a real gateway, a real chain, or a real network.
 *
 * No retry-until-it-works loop anywhere in the payment path: any step
 * failing throws a `DemoAgentStepError` naming exactly which step failed,
 * which is caught once at the top and turned into a non-zero exit code.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  DELIVERY_SUMMARY_META_KEY,
  type DeliverySummary,
  isPaymentRequiredEnvelope,
  PAYMENT_INPUT_FIELD,
} from '../../../src/core/index.js';
import { LOCAL_NETWORK } from '../../../src/payments/x402/chain.js';
import {
  type BalanceReader,
  createBalanceReader,
  formatAssetAmount,
  parseAssetAmount,
} from './balances.js';
import { type LocalChainManifest, loadLocalChainManifest } from './chain-manifest.js';
import { createDemoLogger, type DemoLogger } from './log.js';
import { connectMcpSession, type McpSession } from './mcp-client.js';
import { type CreatePaymentProof, createPaymentProofDynamic } from './payment-client.js';
import { buildToolArguments, isPaidTool } from './tool-args.js';

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

/** Runs the full deterministic buyer flow. Returns the process exit code — never throws. */

/**
 * The most this demo will ever agree to pay, in the asset's smallest unit.
 * The demo resource costs 0.01 USDC = 10_000 units at 6 decimals; this is a
 * deliberate order of magnitude above it, so a challenge asking for more is a
 * refusal rather than a silent overpayment.
 */
export const MAX_DEMO_PAYMENT_UNITS = 100_000n;

/**
 * Refuse a payment requirement that does not match what the buyer intended.
 *
 * A buyer signs an EIP-3009 authorisation for a specific recipient, asset and
 * amount. Everything in the 402 challenge is supplied by the server, so these
 * are the three facts a buyer must confirm against its own expectations before
 * a signature exists — afterwards there is nothing to check, only a transfer
 * to notice.
 */
export function assertPaymentIsExpected(
  // `| undefined` explicitly: a challenge that omits a field is exactly the
  // case worth refusing, and under `exactOptionalPropertyTypes` an optional
  // property is not the same as one that may be undefined.
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

  // The network is what `createPaymentProof` derives the EIP-712 chain id
  // from, so an unpinned one lets a hostile gateway obtain a signature domained
  // to a chain of its choosing — bounded by the pinned asset, but a real gap in
  // a routine every reader is invited to copy.
  if (accepts.network !== expected.network) {
    throw new DemoAgentStepError(
      step,
      `challenge names network "${String(accepts.network)}" but the expected network is "${expected.network}" — refusing to sign`,
    );
  }
  if (!same(accepts.payTo, expected.merchant)) {
    throw new DemoAgentStepError(
      step,
      `challenge pays "${String(accepts.payTo)}" but the expected merchant is "${expected.merchant}" — refusing to sign`,
    );
  }
  if (!same(accepts.asset, expected.asset)) {
    throw new DemoAgentStepError(
      step,
      `challenge is denominated in "${String(accepts.asset)}" but the expected asset is "${expected.asset}" — refusing to sign`,
    );
  }
  let value: bigint;
  try {
    value = BigInt(accepts.amount ?? '');
  } catch {
    throw new DemoAgentStepError(
      step,
      `challenge amount "${String(accepts.amount)}" is not an integer — refusing to sign`,
    );
  }
  if (value <= 0n || value > expected.maxValue) {
    throw new DemoAgentStepError(
      step,
      `challenge asks for ${value} units, outside the accepted range (0, ${expected.maxValue}] — refusing to sign`,
    );
  }
}

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
    log.agent('Agent Commerce Gateway — deterministic buyer demo');

    const manifest = await step('load local chain manifest (.deploy/local.json)', async () =>
      loadManifest(),
    );
    // `manifest.rpcUrl` is the endpoint the *deployer* used — under docker
    // compose that's the container-internal "http://anvil:8545", which this
    // (host-side) process cannot resolve. `hostRpcUrl` is the same chain
    // addressed the way the host reaches it; an explicit X402_RPC_URL always
    // wins, and a manifest written before hostRpcUrl existed still works.
    const rpcUrl = process.env['X402_RPC_URL'] ?? manifest.hostRpcUrl ?? manifest.rpcUrl;
    log.buyer(`address ${manifest.buyer.address} — ${manifest.buyer.note}`);
    log.agent(`merchant ${manifest.merchant.address} — ${manifest.merchant.privateKeyLabel}`);
    log.agent(`asset ${manifest.asset} (${manifest.assetName}) on ${rpcUrl}`);

    const balances = makeBalanceReader(rpcUrl, manifest.asset as `0x${string}`);
    const buyerBefore = await step('read buyer on-chain balance (before)', async () =>
      balances.read(manifest.buyer.address as `0x${string}`),
    );
    const merchantBefore = await step('read merchant on-chain balance (before)', async () =>
      balances.read(manifest.merchant.address as `0x${string}`),
    );
    log.buyer(
      `balance before  ${formatAssetAmount(buyerBefore, manifest.assetDecimals)} ${manifest.assetName}`,
    );
    log.agent(
      `merchant balance before ${formatAssetAmount(merchantBefore, manifest.assetDecimals)} ${manifest.assetName}`,
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
    log.agent(`paid tool: "${paidTool.name}" — free tool: "${freeTool.name}"`);

    const unpaid = await step(`call "${paidTool.name}" with no payment proof`, async () =>
      requireSession(session).callTool(paidTool.name, buildToolArguments(paidTool)),
    );
    if (unpaid.isError !== true) {
      throw new DemoAgentStepError(
        `call "${paidTool.name}" with no payment proof`,
        `expected an isError response (PAYMENT_REQUIRED), delivery succeeded unpaid: ${summarise(unpaid)}`,
      );
    }
    const structured = unpaid.structuredContent;
    if (!isPaymentRequiredEnvelope(structured)) {
      throw new DemoAgentStepError(
        `call "${paidTool.name}" with no payment proof`,
        `expected a PaymentRequiredEnvelope, got: ${summarise(unpaid)}`,
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

    // check the challenge BEFORE signing it.
    //
    // `createPaymentProof` takes `to`, `value` and `asset` straight from the
    // requirement and signs — so a gateway (or anything able to answer as one)
    // dictates who gets paid and how much. The balance check further down
    // compares the on-chain delta against *the same server-supplied number*,
    // after the funds have moved, which confirms arithmetic rather than
    // intent. Damage here is bounded by a single-use nonce and a local chain,
    // and this demo does trust its own gateway — but demos get copied, and a
    // real buyer that signs an unchecked challenge has no recourse. These
    // assertions are what that buyer must do, written out.
    assertPaymentIsExpected(accepts, {
      merchant: manifest.merchant.address,
      asset: manifest.asset,
      maxValue: BigInt(MAX_DEMO_PAYMENT_UNITS),
      network: process.env['X402_NETWORK'] ?? LOCAL_NETWORK,
    });
    log.buyer(
      `challenge checked before signing: pays ${accepts.amount} units of ${accepts.asset} to ${accepts.payTo}`,
    );

    const proof = await step('build the x402 payment proof', async () =>
      createProof({
        buyerPrivateKey: manifest.buyer.privateKey as `0x${string}`,
        rpcUrl,
        accepts,
      }),
    );
    log.buyer(`signed x402 payment proof — ${manifest.buyer.note}`);

    const paid = await step(`retry "${paidTool.name}" with the payment proof`, async () =>
      requireSession(session).callTool(paidTool.name, {
        ...buildToolArguments(paidTool),
        [PAYMENT_INPUT_FIELD]: proof,
      }),
    );
    if (paid.isError === true) {
      throw new DemoAgentStepError(
        `retry "${paidTool.name}" with the payment proof`,
        `gateway rejected the paid call: ${summarise(paid)}`,
      );
    }
    log.gateway(`delivered "${paidTool.name}"`);

    // The buyer's ONLY route to its own receipt: it holds no gateway
    // credential, so it never calls the admin-token-gated `/api/receipts`
    // (that is the merchant's ledger, not the buyer's). A missing summary
    // here is a real protocol-adapter defect, not something to skip past.
    const summary = readDeliverySummary(paid);
    logDeliverySummary(log, summary);

    const buyerAfter = await step('read buyer on-chain balance (after)', async () =>
      balances.read(manifest.buyer.address as `0x${string}`),
    );
    const merchantAfter = await step('read merchant on-chain balance (after)', async () =>
      balances.read(manifest.merchant.address as `0x${string}`),
    );
    log.buyer(
      `balance after   ${formatAssetAmount(buyerAfter, manifest.assetDecimals)} ${manifest.assetName}  (Δ ${formatAssetAmount(buyerAfter - buyerBefore, manifest.assetDecimals)})`,
    );
    log.agent(
      `merchant balance after  ${formatAssetAmount(merchantAfter, manifest.assetDecimals)} ${manifest.assetName}  (Δ ${formatAssetAmount(merchantAfter - merchantBefore, manifest.assetDecimals)})`,
    );

    const expectedDelta = parseAssetAmount(envelope.payment.amount, manifest.assetDecimals);
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
    log.agent(
      'balance delta confirms on-chain settlement — that is the proof, not the HTTP status.',
    );

    const free = await step(`call free tool "${freeTool.name}"`, async () =>
      requireSession(session).callTool(freeTool.name, buildToolArguments(freeTool)),
    );
    if (free.isError === true) {
      throw new DemoAgentStepError(
        `call free tool "${freeTool.name}"`,
        `gateway rejected the free call: ${summarise(free)}`,
      );
    }
    log.gateway(`delivered free tool "${freeTool.name}": ${summarise(free)}`);

    log.agent('demo complete — free and paid delivery both verified.');
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
 * Reads the payer-facing `DeliverySummary` off a delivered `CallToolResult`'s
 * `_meta`, under the frozen `DELIVERY_SUMMARY_META_KEY`. This is only a
 * shape check, not full validation: the summary crosses the wire from a
 * gateway this demo already trusts (it just verified the same gateway's
 * payment challenge and settlement), so the bar here is "the adapter
 * actually sent something", not defence against a hostile server.
 */
function readDeliverySummary(result: CallToolResult): DeliverySummary {
  const raw = result._meta?.[DELIVERY_SUMMARY_META_KEY];
  if (raw === undefined || typeof raw !== 'object' || raw === null) {
    throw new DemoAgentStepError(
      'read delivery summary',
      `delivered result carried no "${DELIVERY_SUMMARY_META_KEY}" _meta — the buyer has no ` +
        'other way to learn its own receipt (it holds no gateway credential and does not call ' +
        '/api/receipts)',
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

function summarise(result: CallToolResult): string {
  const body = result.structuredContent ?? result.content;
  const text = JSON.stringify(body);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}
