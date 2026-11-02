import * as http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_LOGGER } from '../../../src/core';
import { createGateway } from '../../../src/gateway/server';
import { createFakeHttpAdapter, createFakeStore, makeGatewayConfig } from './helpers';

// Keep the socket open after reading the response to exercise idle cleanup
function get(url: string, agent: http.Agent): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject);
  });
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timed out'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timed out'>((resolve) => {
    timer = setTimeout(() => resolve('timed out'), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

describe('gateway.close()', () => {
  it('lets an in-flight request finish before stopping adapters, then returns without waiting for keep-alive', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const adapter = createFakeHttpAdapter({
      handleHttp: async (_req, res) => {
        arrived();
        await held;
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('done');
        order.push('response');
      },
      stop: async () => {
        order.push('stop');
      },
    });
    const gateway = await createGateway({
      config: makeGatewayConfig(),
      store: createFakeStore(),
      paymentProviders: [],
      protocolAdapters: [adapter],
      logger: NOOP_LOGGER,
    });
    const { url } = await gateway.listen();
    const agent = new http.Agent({ keepAlive: true });
    try {
      const response = get(`${url}/mcp`, agent);
      await inFlight;

      const closed = gateway.close();
      // Wait until Fastify stops listening so the socket becomes idle after
      // Node's initial sweep, exercising the gateway's repeated sweep
      await vi.waitFor(() => expect(gateway.server.server.listening).toBe(false));
      expect(order).toEqual([]);
      release();

      expect(await response).toBe(200);
      // Fastify's keep-alive timeout is 72 s; the idle sweep runs every 100 ms
      expect(await within(closed, 5_000)).toBeUndefined();
      expect(order).toEqual(['response', 'stop']);
    } finally {
      agent.destroy();
    }
  });
});
