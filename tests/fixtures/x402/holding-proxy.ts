import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface HoldingProxy {
  readonly url: string;
  /**
   * Withholds responses to later requests matching the rule. With `forward`,
   * read the upstream response first; otherwise do not forward the request.
   * Resolves when the first matching request reaches that hold point.
   */
  hold(
    match: (path: string, body: string) => boolean,
    options: { readonly forward: boolean },
  ): Promise<void>;
  /** Drops held requests and closes the listener */
  close(): Promise<void>;
}

/**
 * Starts an HTTP proxy that can pause selected requests before forwarding or
 * after reading the response from `upstream`, for facilitator `/settle` calls
 * or RPC broadcasts
 */
export async function startHoldingProxy(upstream: string): Promise<HoldingProxy> {
  let rule:
    | {
        readonly match: (path: string, body: string) => boolean;
        readonly forward: boolean;
        readonly arrived: () => void;
      }
    | undefined;
  const held = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const path = request.url ?? '/';
    const matched = rule?.match(path, body) === true ? rule : undefined;
    if (matched !== undefined && !matched.forward) {
      held.add(response);
      matched.arrived();
      return;
    }
    const forwarded = await fetch(new URL(path, upstream), {
      method: request.method ?? 'GET',
      headers: { 'content-type': request.headers['content-type'] ?? 'application/json' },
      ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body }),
    });
    const text = await forwarded.text();
    if (matched !== undefined) {
      held.add(response);
      matched.arrived();
      return;
    }
    response.statusCode = forwarded.status;
    response.setHeader('content-type', forwarded.headers.get('content-type') ?? 'application/json');
    response.end(text);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hold: (match, { forward }) =>
      new Promise<void>((resolve) => {
        rule = { match, forward, arrived: resolve };
      }),
    close: () => {
      for (const response of held) response.destroy();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
