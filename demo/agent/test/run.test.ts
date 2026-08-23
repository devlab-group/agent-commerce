import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DELIVERY_SUMMARY_META_KEY, type DeliverySummary } from '../../../src/core/index.js';
import type { BalanceReader } from '../src/balances.js';
import type { LocalChainManifest } from '../src/chain-manifest.js';
import { createDemoLogger } from '../src/log.js';
import type { McpSession } from '../src/mcp-client.js';
import {
  assertPaymentIsExpected,
  type DemoAgentDeps,
  MAX_DEMO_PAYMENT_UNITS,
  runDemoAgent,
} from '../src/run.js';

const FREE_TOOL: Tool = {
  name: 'weather_basic',
  description: 'free',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};
const PAID_TOOL: Tool = {
  name: 'market_report',
  description: 'paid',
  inputSchema: { type: 'object', properties: { _payment: { type: 'string' } } },
};

function makeManifest(overrides: Partial<LocalChainManifest> = {}): LocalChainManifest {
  return {
    chainId: 84532,
    rpcUrl: 'http://127.0.0.1:8545',
    asset: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
    assetName: 'MockUSDC',
    assetVersion: '2',
    assetDecimals: 6,
    merchant: {
      address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      privateKeyLabel: 'LOCAL DEVELOPMENT ONLY - DO NOT FUND',
    },
    buyer: {
      address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      privateKey: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
      note: 'LOCAL DEVELOPMENT ONLY - DO NOT FUND',
    },
    facilitator: {
      address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      note: 'LOCAL DEVELOPMENT ONLY - DO NOT FUND',
    },
    buyerInitialBalance: '100.00',
    ...overrides,
  };
}

function makeDeliverySummary(overrides: Partial<DeliverySummary> = {}): DeliverySummary {
  return {
    requestId: overrides.requestId ?? 'req_new',
    resourceId: overrides.resourceId ?? 'market_report',
    receiptId: overrides.receiptId ?? 'r_new',
    deliveredAt: overrides.deliveredAt ?? '2026-01-01T00:00:00.000Z',
    payment: overrides.payment ?? {
      status: 'settled',
      amount: '0.01',
      currency: 'USDC',
      externalReference: '0xtxhash',
    },
  };
}

const PAYMENT_REQUIRED_ENVELOPE = {
  status: 'payment-required' as const,
  code: 'PAYMENT_REQUIRED' as const,
  requestId: 'req1',
  resourceId: 'market_report',
  message: 'Payment required',
  payment: {
    provider: 'x402' as const,
    version: '1',
    amount: '0.01',
    currency: 'USDC',
    destination: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    // Must match the fixture manifest's merchant/asset and stay under the
    // demo's cap: the buyer now checks the challenge before signing it
    //, so a fixture that does not match is a refusal.
    accepts: [
      {
        scheme: 'exact',
        // The buyer pins this before signing: it is what the EIP-712 chain id
        // is derived from, so a fixture that omits it is a refusal.
        network: 'eip155:84532',
        payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        asset: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
        amount: '10000',
      },
    ],
  },
};

const DEFAULT_UNPAID_RESULT: CallToolResult = {
  isError: true,
  content: [{ type: 'text', text: 'Payment required' }],
  structuredContent: PAYMENT_REQUIRED_ENVELOPE,
};
const DEFAULT_PAID_RESULT: CallToolResult = {
  content: [{ type: 'text', text: '{"report":"ok"}' }],
  structuredContent: { report: 'ok' },
  _meta: { [DELIVERY_SUMMARY_META_KEY]: makeDeliverySummary() },
};
const DEFAULT_FREE_RESULT: CallToolResult = {
  content: [{ type: 'text', text: '{"temp":10}' }],
  structuredContent: { temp: 10 },
};

interface HarnessOptions {
  readonly buyerBefore?: bigint;
  readonly merchantBefore?: bigint;
  readonly buyerAfter?: bigint;
  readonly merchantAfter?: bigint;
  readonly manifest?: LocalChainManifest;
  readonly tools?: readonly Tool[];
  readonly unpaidResult?: CallToolResult;
  readonly paidResult?: CallToolResult;
  readonly freeResult?: CallToolResult;
  readonly overrides?: DemoAgentDeps;
}

function makeHappyDeps(options: HarnessOptions = {}): { deps: DemoAgentDeps; lines: string[] } {
  const manifest = options.manifest ?? makeManifest();
  const lines: string[] = [];
  const balancesBefore = {
    buyer: options.buyerBefore ?? 100_000_000n,
    merchant: options.merchantBefore ?? 0n,
  };
  const balancesAfter = {
    buyer: options.buyerAfter ?? balancesBefore.buyer - 10_000n,
    merchant: options.merchantAfter ?? balancesBefore.merchant + 10_000n,
  };
  let balanceReadCount = 0;
  let paidCallCount = 0;

  const balanceReader: BalanceReader = {
    async read(address) {
      const isBuyer = address.toLowerCase() === manifest.buyer.address.toLowerCase();
      const useBefore = balanceReadCount < 2;
      balanceReadCount += 1;
      const value = useBefore ? balancesBefore : balancesAfter;
      return isBuyer ? value.buyer : value.merchant;
    },
  };

  const session: McpSession = {
    async listTools() {
      return options.tools ?? [FREE_TOOL, PAID_TOOL];
    },
    async callTool(name, args) {
      if (name === FREE_TOOL.name) {
        return options.freeResult ?? DEFAULT_FREE_RESULT;
      }
      paidCallCount += 1;
      if (paidCallCount === 1) {
        return options.unpaidResult ?? DEFAULT_UNPAID_RESULT;
      }
      expect(args['_payment']).toBeTruthy();
      return options.paidResult ?? DEFAULT_PAID_RESULT;
    },
    async close() {},
  };

  const deps: DemoAgentDeps = {
    logger: createDemoLogger((line) => lines.push(line)),
    gatewayUrl: 'http://127.0.0.1:8080',
    loadManifest: () => manifest,
    connectMcp: async () => session,
    createPaymentProof: async () => 'base64-proof',
    createBalanceReader: () => balanceReader,
    ...options.overrides,
  };
  return { deps, lines };
}

describe('runDemoAgent — happy path', () => {
  it('completes with exit code 0 and verifies the balance delta', async () => {
    const { deps, lines } = makeHappyDeps();
    const code = await runDemoAgent(deps);
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('demo complete');
    expect(text).toContain('402 payment required');
    expect(text).toContain('balance delta confirms on-chain settlement');
    expect(text).toContain('settlementTx=0xtxhash');
  });

  it('discovers and prints the free and paid tools', async () => {
    const { deps, lines } = makeHappyDeps();
    await runDemoAgent(deps);
    const text = lines.join('\n');
    expect(text).toContain('paid tool: "market_report"');
    expect(text).toContain('free tool: "weather_basic"');
  });
});

describe('runDemoAgent — failure steps fail loudly, naming the step, no retries', () => {
  it('fails when the manifest cannot be loaded', async () => {
    const { deps, lines } = makeHappyDeps({
      overrides: {
        loadManifest: () => {
          throw new Error('no manifest');
        },
      },
    });
    const code = await runDemoAgent(deps);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('FAIL at step "load local chain manifest');
  });

  it('fails when no paid tool is discovered', async () => {
    const { deps, lines } = makeHappyDeps({ tools: [FREE_TOOL] });
    const code = await runDemoAgent(deps);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('FAIL at step "find a paid tool"');
  });

  it('fails when no free tool is discovered', async () => {
    const { deps, lines } = makeHappyDeps({ tools: [PAID_TOOL] });
    const code = await runDemoAgent(deps);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('FAIL at step "find a free tool"');
  });

  it('fails when the unpaid call unexpectedly succeeds instead of requiring payment', async () => {
    const { deps, lines } = makeHappyDeps({
      unpaidResult: {
        content: [{ type: 'text', text: 'oops delivered free' }],
        structuredContent: { ok: true },
      },
    });
    const code = await runDemoAgent(deps);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('call "market_report" with no payment proof');
  });

  it('fails when the unpaid response is not a well-formed PaymentRequiredEnvelope', async () => {
    const { deps, lines } = makeHappyDeps({
      unpaidResult: {
        isError: true,
        content: [{ type: 'text', text: 'weird' }],
        structuredContent: { status: 'error' },
      },
    });
    const code = await runDemoAgent(deps);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('PaymentRequiredEnvelope');
  });

  it('fails when building the payment proof throws — no retry, immediate failure', async () => {
    const { deps, lines } = makeHappyDeps({
      overrides: {
        createPaymentProof: async () => {
          throw new Error('signing failed');
        },
      },
    });
    const code = await runDemoAgent(deps);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain(
      'FAIL at step "build the x402 payment proof": signing failed',
    );
  });

  it('fails when the gateway rejects the paid retry', async () => {
    const { deps, lines } = makeHappyDeps({
      paidResult: {
        isError: true,
        content: [{ type: 'text', text: 'rejected' }],
        structuredContent: { code: 'PAYMENT_INVALID' },
      },
    });
    const code = await runDemoAgent(deps);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('retry "market_report" with the payment proof');
  });

  it('fails loudly (not silently) when a delivered paid result carries no delivery-summary _meta', async () => {
    const { deps, lines } = makeHappyDeps({
      paidResult: {
        content: [{ type: 'text', text: '{"report":"ok"}' }],
        structuredContent: { report: 'ok' },
        // no _meta at all — the buyer has no admin token, so this is its
        // only route to a receipt, and a defect here must not be skipped.
      },
    });
    const code = await runDemoAgent(deps);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('read delivery summary');
  });

  it('fails when the merchant balance does not move by the expected amount', async () => {
    const { deps, lines } = makeHappyDeps({ merchantAfter: 0n }); // no change at all
    const code = await runDemoAgent(deps);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('verify settlement moved funds on-chain');
  });

  it('fails when the buyer balance does not move by the expected amount', async () => {
    const { deps, lines } = makeHappyDeps({ buyerAfter: 100_000_000n }); // unchanged
    const code = await runDemoAgent(deps);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('verify settlement moved funds on-chain');
  });

  it('fails when the free tool call is rejected', async () => {
    const { deps, lines } = makeHappyDeps({
      freeResult: { isError: true, content: [{ type: 'text', text: 'nope' }] },
    });
    const code = await runDemoAgent(deps);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('call free tool "weather_basic"');
  });

  it('fails when connecting to the MCP endpoint throws', async () => {
    const { deps, lines } = makeHappyDeps({
      overrides: {
        connectMcp: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    });
    const code = await runDemoAgent(deps);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('connect to the gateway MCP endpoint');
  });
});

describe('runDemoAgent — RPC URL resolution (host vs. container-internal)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Runs just far enough to capture the rpcUrl handed to createBalanceReader, then bails out. */
  async function resolvedRpcUrl(
    manifestOverrides: Partial<LocalChainManifest>,
  ): Promise<string | undefined> {
    let captured: string | undefined;
    const deps: DemoAgentDeps = {
      logger: createDemoLogger(() => {}),
      loadManifest: () => makeManifest(manifestOverrides),
      createBalanceReader: (rpcUrl) => {
        captured = rpcUrl;
        return { read: async () => 0n };
      },
      connectMcp: async () => {
        throw new Error('stop here — only rpcUrl resolution is under test');
      },
    };
    await runDemoAgent(deps);
    return captured;
  }

  it('uses manifest.hostRpcUrl when present and no X402_RPC_URL override (docker compose case)', async () => {
    const url = await resolvedRpcUrl({
      rpcUrl: 'http://anvil:8545',
      hostRpcUrl: 'http://127.0.0.1:8545',
    });
    expect(url).toBe('http://127.0.0.1:8545');
  });

  it('falls back to manifest.rpcUrl when hostRpcUrl is absent (older manifest / native host deploy)', async () => {
    const url = await resolvedRpcUrl({ rpcUrl: 'http://127.0.0.1:8545' });
    expect(url).toBe('http://127.0.0.1:8545');
  });

  it('an explicit X402_RPC_URL always wins over both manifest fields', async () => {
    vi.stubEnv('X402_RPC_URL', 'http://explicit-override:9999');
    const url = await resolvedRpcUrl({
      rpcUrl: 'http://anvil:8545',
      hostRpcUrl: 'http://127.0.0.1:8545',
    });
    expect(url).toBe('http://explicit-override:9999');
  });
});

describe('the buyer checks the 402 challenge before signing', () => {
  // `createPaymentProof` takes `to`, `value` and `asset` straight from the
  // challenge and signs. The balance check after delivery compares the on-chain
  // delta against that same server-supplied number, so it confirms arithmetic,
  // not intent — by then the funds have moved. Demos get copied; this is the
  // check a real buyer must make, and these are the cases it must refuse.
  const expected = {
    merchant: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    asset: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    maxValue: MAX_DEMO_PAYMENT_UNITS,
    network: 'eip155:84532',
  };
  const good = {
    payTo: expected.merchant,
    asset: expected.asset,
    amount: '10000',
    network: expected.network,
  };

  it('accepts the challenge the demo actually expects', () => {
    expect(() => assertPaymentIsExpected(good, expected)).not.toThrow();
  });

  it('accepts a differently-cased address — addresses are checksum-insensitive here', () => {
    expect(() =>
      assertPaymentIsExpected({ ...good, payTo: expected.merchant.toLowerCase() }, expected),
    ).not.toThrow();
  });

  it.each([
    [
      'a redirected recipient',
      { payTo: '0x000000000000000000000000000000000000dEaD' },
      'expected merchant',
    ],
    [
      'a substituted asset',
      { asset: '0x000000000000000000000000000000000000dEaD' },
      'expected asset',
    ],
    ['an amount above the cap', { amount: '100001' }, 'outside the accepted range'],
    ['a zero amount', { amount: '0' }, 'outside the accepted range'],
    ['a non-integer amount', { amount: '1.5' }, 'not an integer'],
    ['a missing recipient', { payTo: undefined }, 'expected merchant'],
    // The network decides the chain id signed into the EIP-712 domain, so an
    // unpinned one lets the challenge choose which chain the signature is for.
    ['a substituted network', { network: 'eip155:1' }, 'expected network'],
    ['a missing network', { network: undefined }, 'expected network'],
  ])('refuses to sign %s', (_label, override, expectedMessage) => {
    expect(() => assertPaymentIsExpected({ ...good, ...override }, expected)).toThrowError(
      new RegExp(expectedMessage),
    );
  });
});
