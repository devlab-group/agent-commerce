/**
 * Throwaway `node:http` server wrapping `HttpProtocolAdapter.handleHttp`, so
 * conformance tests drive the adapter through a real MCP client over a real
 * Streamable HTTP transport rather than calling internal functions directly.
 */
import { createServer, type Server as NodeHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HttpProtocolAdapter } from '../../../src/core/index.js';

export interface RunningAdapterServer {
  readonly url: string;
  close(): Promise<void>;
}

export async function startAdapterServer(
  adapter: HttpProtocolAdapter,
): Promise<RunningAdapterServer> {
  const server: NodeHttpServer = createServer((req, res) => {
    adapter.handleHttp(req, res).catch((err: unknown) => {
      // The adapter contract requires handleHttp to never throw; a throw
      // here is a test-harness-visible adapter bug, not an expected path.
      if (!res.headersSent) {
        res.writeHead(500);
      }
      if (!res.writableEnded) {
        res.end();
      }
      // eslint-disable-next-line no-console
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
