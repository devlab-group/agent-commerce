import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EventFeed } from '../src/components/EventFeed.js';
import { ReceiptList } from '../src/components/ReceiptList.js';
import { ResourceList } from '../src/components/ResourceList.js';
import { StatusPanel } from '../src/components/StatusPanel.js';
import type {
  AdapterDescriptor,
  AdapterWithHealth,
  CommerceEvent,
  CommerceReceipt,
  PublicResource,
} from '../src/lib/types.js';

function render<P extends object>(component: (props: P) => ReactElement | null, props: P): string {
  return renderToStaticMarkup(createElement(component, props));
}

describe('ResourceList', () => {
  const resource: PublicResource = {
    id: 'market_report',
    name: 'Premium Market Report',
    method: 'GET',
    pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
    exposedVia: ['http', 'mcp'],
    paymentMethods: ['x402'],
  };

  it('renders resource name, price and protocols', () => {
    const html = render(ResourceList, { resources: [resource] });
    expect(html).toContain('Premium Market Report');
    expect(html).toContain('0.01 USDC');
    expect(html).toContain('http, mcp');
  });

  it('renders "Free" for a free resource', () => {
    const html = render(ResourceList, { resources: [{ ...resource, pricing: { type: 'free' } }] });
    expect(html).toContain('Free');
  });

  it('renders an empty state when there are no resources', () => {
    const html = render(ResourceList, { resources: [] });
    expect(html).toContain('No resources configured');
  });

  it('renders the error state without a table', () => {
    const html = render(ResourceList, { resources: [], error: 'boom' });
    expect(html).toContain('boom');
    expect(html).not.toContain('<table');
  });
});

describe('StatusPanel', () => {
  const adapter: AdapterWithHealth = {
    name: 'mcp',
    kind: 'protocol',
    implementationVersion: '0.1.0',
    supportedSpec: 'mcp/2025-06-18',
    capabilities: ['tools'],
    status: 'stable',
    health: { status: 'pass', checkedAt: '2026-01-01T00:00:00.000Z' },
  };
  const storeDescriptor: AdapterDescriptor = {
    name: 'sqlite-receipt-store',
    kind: 'storage',
    implementationVersion: '0.1.0',
    supportedSpec: 'sqlite-schema-v1',
    capabilities: ['receipts'],
    status: 'stable',
  };

  it('renders an adapter row with its status and spec', () => {
    const html = render(StatusPanel, {
      wellKnown: {
        gateway: {
          implementationVersion: '0.1.0',
          supportedSpec: 'agent-commerce/v1.0.0',
        },
        merchant: { id: 'demo', name: 'Demo Merchant', publicBaseUrl: 'http://localhost:8080' },
        protocols: { http: { enabled: true }, mcp: { enabled: true, mountPath: '/mcp' } },
        adapters: [adapter],
        paymentProviders: [],
        store: storeDescriptor,
        payments: {},
      },
    });
    expect(html).toContain('mcp');
    expect(html).toContain('mcp/2025-06-18');
    expect(html).toContain('PASS');
  });

  it('shows an "unsupported" capability honestly, not a green tick', () => {
    const html = render(StatusPanel, {
      wellKnown: {
        gateway: {
          implementationVersion: '0.1.0',
          supportedSpec: 'agent-commerce/v1.0.0',
        },
        merchant: { id: 'demo', name: 'Demo Merchant', publicBaseUrl: 'http://localhost:8080' },
        protocols: { http: { enabled: true }, mcp: { enabled: true, mountPath: '/mcp' } },
        adapters: [{ ...adapter, unsupported: ['resources/subscribe'] }],
        paymentProviders: [],
        store: storeDescriptor,
        payments: {},
      },
    });
    expect(html).toContain('resources/subscribe');
  });

  it('shows the x402 settlement destination and network when enabled', () => {
    const html = render(StatusPanel, {
      wellKnown: {
        gateway: {
          implementationVersion: '0.1.0',
          supportedSpec: 'agent-commerce/v1.0.0',
        },
        merchant: { id: 'demo', name: 'Demo Merchant', publicBaseUrl: 'http://localhost:8080' },
        protocols: { http: { enabled: true }, mcp: { enabled: true, mountPath: '/mcp' } },
        adapters: [],
        paymentProviders: [],
        store: storeDescriptor,
        payments: {
          x402: {
            enabled: true,
            network: 'eip155:84532',
            asset: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
            assetName: 'MockUSDC',
            assetVersion: '2',
            assetDecimals: 6,
            payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
            maxTimeoutSeconds: 120,
            facilitator: { mode: 'local' },
            mode: 'local',
          },
        },
      },
    });
    expect(html).toContain('eip155:84532');
    expect(html).toContain('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  });

  it('renders an honest message when x402 is not enabled', () => {
    const html = render(StatusPanel, {
      wellKnown: {
        gateway: {
          implementationVersion: '0.1.0',
          supportedSpec: 'agent-commerce/v1.0.0',
        },
        merchant: { id: 'demo', name: 'Demo Merchant', publicBaseUrl: 'http://localhost:8080' },
        protocols: { http: { enabled: true }, mcp: { enabled: false, mountPath: '/mcp' } },
        adapters: [],
        paymentProviders: [],
        store: storeDescriptor,
        payments: {},
      },
    });
    expect(html).toContain('not enabled');
  });
});

describe('EventFeed', () => {
  const event: CommerceEvent = {
    id: 'e1',
    type: 'resource.delivered',
    requestId: 'req_abcdefghijklmnop',
    at: '2026-01-01T00:00:00.000Z',
    resourceId: 'market_report',
  };

  it('renders the event type, request id and resource', () => {
    const html = render(EventFeed, { events: [event], status: 'live' });
    expect(html).toContain('resource.delivered');
    expect(html).toContain('market_report');
    expect(html).toContain('Live');
  });

  it('caps the number of rendered rows at maxRows', () => {
    const events = Array.from({ length: 10 }, (_, i) => ({ ...event, id: `e${i}` }));
    const html = render(EventFeed, { events, status: 'live', maxRows: 3 });
    const rowCount = (html.match(/<tr[ >]/g) ?? []).length - 1; // subtract the thead row
    expect(rowCount).toBe(3);
  });

  it('highlights the row matching highlightRequestId', () => {
    const html = render(EventFeed, {
      events: [event],
      status: 'live',
      highlightRequestId: event.requestId,
    });
    expect(html).toMatch(/class="highlight[ "]/);
  });

  it('renders each stream status distinctly', () => {
    for (const status of ['connecting', 'live', 'reconnecting', 'polling'] as const) {
      const html = render(EventFeed, { events: [], status });
      expect(html).toContain('<span');
    }
  });

  // Polling is the intended authenticated path whenever an admin token is
  // configured (SSE cannot carry it), not just a degraded fallback — the label must not claim the
  // stream is "down" when it may simply be working exactly as designed.
  it('does not describe "polling" status as the stream being down', () => {
    const html = render(EventFeed, { events: [], status: 'polling' });
    expect(html).toContain('Polling');
    expect(html).not.toMatch(/stream down/i);
  });
});

describe('ReceiptList', () => {
  const receipt: CommerceReceipt = {
    id: 'r1',
    requestId: 'req_abcdefghijklmnop',
    resourceId: 'market_report',
    deliveredAt: '2026-01-01T00:00:00.000Z',
    backendStatus: 200,
    payment: {
      status: 'settled',
      provider: 'x402',
      amount: '0.01',
      currency: 'USDC',
      externalReference: '0xtxhash',
    },
  };

  it('renders resource, amount, payment status and settlement reference', () => {
    const html = render(ReceiptList, { receipts: [receipt] });
    expect(html).toContain('market_report');
    expect(html).toContain('0.01 USDC');
    expect(html).toContain('settled');
    expect(html).toContain('0xtxhash');
  });

  it('renders "Free" for a receipt with no payment', () => {
    const { payment: _payment, ...freeReceipt } = receipt;
    const html = render(ReceiptList, { receipts: [freeReceipt] });
    expect(html).toContain('Free');
  });

  it('highlights the row matching highlightRequestId, visually correlating with the event feed', () => {
    const html = render(ReceiptList, {
      receipts: [receipt],
      highlightRequestId: receipt.requestId,
    });
    expect(html).toMatch(/class="highlight[ "]/);
  });

  // A settled payment with a non-2xx backendStatus is the one row an operator
  // must be able to spot — there are no refunds, so seeing it is the only
  // remedy. Without this, it renders identically to a successful delivery.
  describe('paid-but-undelivered visibility', () => {
    it('renders a settled+500 receipt as not delivered and highlights it for attention', () => {
      const undelivered: CommerceReceipt = { ...receipt, backendStatus: 500 };
      const html = render(ReceiptList, { receipts: [undelivered] });
      expect(html).toContain('not delivered (500)');
      expect(html).toMatch(/class="[^"]*\battention\b[^"]*"/);
    });

    it('renders "not delivered (no response)" when backendStatus is 0', () => {
      const noResponse: CommerceReceipt = { ...receipt, backendStatus: 0 };
      const html = render(ReceiptList, { receipts: [noResponse] });
      expect(html).toContain('not delivered (no response)');
      expect(html).toMatch(/class="[^"]*\battention\b[^"]*"/);
    });

    it('renders a settled+200 receipt as delivered, not flagged for attention', () => {
      const html = render(ReceiptList, { receipts: [receipt] }); // backendStatus: 200
      expect(html).toContain('delivered');
      expect(html).not.toContain('not delivered');
      expect(html).not.toMatch(/class="[^"]*\battention\b[^"]*"/);
    });

    it('renders a free (no payment), 200 receipt normally — not flagged, delivered', () => {
      const { payment: _payment, ...freeReceipt } = receipt;
      const html = render(ReceiptList, { receipts: [freeReceipt] }); // backendStatus: 200
      expect(html).toContain('delivered');
      expect(html).not.toMatch(/class="[^"]*\battention\b[^"]*"/);
    });

    it('does NOT flag a free receipt for attention even when its backend failed — only a settled payment does', () => {
      const { payment: _payment, ...freeReceipt } = receipt;
      const freeFailed: CommerceReceipt = { ...freeReceipt, backendStatus: 500 };
      const html = render(ReceiptList, { receipts: [freeFailed] });
      expect(html).toContain('not delivered (500)');
      expect(html).not.toMatch(/class="[^"]*\battention\b[^"]*"/);
    });
  });
});
