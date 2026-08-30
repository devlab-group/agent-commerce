/**
 * Version negotiation. The SDK's own client always stamps
 * `A2A-Version: <transport version>` on every call, so the positive case is
 * covered by the SDK itself; the refusals are driven over raw HTTP, because a
 * conformant client cannot be made to send a wrong one.
 */
import { ClientFactory } from '@a2a-js/sdk/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningGateway, startConformanceGateway } from './support/gateway.js';

let running: RunningGateway;

beforeAll(async () => {
  running = await startConformanceGateway();
});

afterAll(async () => {
  await running?.close();
});

interface JsonRpcResponse {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly result?: unknown;
  readonly error?: { code: number; message: string };
}

async function post(body: string, headers: Record<string, string>): Promise<JsonRpcResponse> {
  const response = await fetch(`${running.url}/a2a`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  return (await response.json()) as JsonRpcResponse;
}

const SEND_MESSAGE = JSON.stringify({
  jsonrpc: '2.0',
  id: 'v-1',
  method: 'SendMessage',
  params: {
    message: {
      role: 'ROLE_USER',
      messageId: 'msg-1',
      parts: [{ data: { resource: 'weather_basic', input: { city: 'Berlin' } } }],
    },
  },
});

describe('A2A protocol version negotiation', () => {
  it('accepts 1.0, the version the official client sends', async () => {
    // Proven by the SDK actually completing a call against this gateway.
    const client = await new ClientFactory().createFromUrl(running.url);
    expect(client.protocolVersion).toBe('1.0');

    const body = await post(SEND_MESSAGE, { 'A2A-Version': '1.0' });
    expect(body.error).toBeUndefined();
  });

  it.each([
    ['a missing header', {}],
    ['the previous revision', { 'A2A-Version': '0.3' }],
    ['an unreleased revision', { 'A2A-Version': '2.0' }],
    ['a non-version string', { 'A2A-Version': 'latest' }],
  ])('refuses %s as an unsupported operation', async (_label, headers) => {
    const body = await post(SEND_MESSAGE, headers);

    expect(body.error?.code).toBe(-32004);
    expect(body.error?.message).toContain('1.0');
    expect(body.result).toBeUndefined();
  });

  it('matches the header case-insensitively, as HTTP requires', async () => {
    const body = await post(SEND_MESSAGE, { 'a2a-VERSION': '1.0' });
    expect(body.error).toBeUndefined();
  });
});
