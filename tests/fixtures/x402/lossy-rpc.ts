import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface LossyRpc {
  readonly url: string;
  close(): Promise<void>;
}

// Forwards JSON-RPC to `upstream`, but answers `eth_sendRawTransaction` with an
// error after the node has accepted it: a broadcast whose response was lost
export async function startLossyRpc(upstream: string): Promise<LossyRpc> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const forwarded = await fetch(upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const text = await forwarded.text();
    const call = JSON.parse(body) as { id?: unknown; method?: string };
    response.setHeader('content-type', 'application/json');
    response.end(
      call.method === 'eth_sendRawTransaction'
        ? JSON.stringify({
            jsonrpc: '2.0',
            id: call.id,
            error: { code: -32603, message: 'upstream connection reset' },
          })
        : text,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
