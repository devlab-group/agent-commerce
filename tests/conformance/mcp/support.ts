/**
 * Throwaway `node:http` server wrapping `HttpProtocolAdapter.handleHttp`, so
 * conformance tests drive the adapter through a real MCP client over a real
 * Streamable HTTP transport rather than calling internal functions directly
 */
import { createServer, type Server as NodeHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HttpProtocolAdapter } from '../../../src/core';

export interface RunningAdapterServer {
  readonly url: string;
  close(): Promise<void>;
}

export async function startAdapterServer(
  adapter: HttpProtocolAdapter,
): Promise<RunningAdapterServer> {
  const server: NodeHttpServer = createServer((req, res) => {
    adapter.handleHttp(req, res).catch((err: unknown) => {
      // The MCP adapter catches its own failures, so a rejection here is an adapter bug
      if (!res.headersSent) {
        res.writeHead(500);
      }
      if (!res.writableEnded) {
        res.end();
      }
      console.error('test harness: adapter.handleHttp rejected unexpectedly', err);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
