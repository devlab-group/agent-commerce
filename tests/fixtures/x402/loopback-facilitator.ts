/**
 * Test-only SDK `x402Facilitator`, using the local binding over HTTP on
 * 127.0.0.1. Settles on Anvil chains with custom IDs to exercise the gateway
 * remote path. LOCAL DEVELOPMENT ONLY.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLocalFacilitatorClient } from '../../../src/payments/x402/chain';
import type { FacilitatorBinding } from '../../../src/payments/x402/facilitator';
import { createLocalFacilitatorBinding } from '../../../src/payments/x402/local-facilitator';

export interface LoopbackChain {
  readonly network: `eip155:${number}`;
  readonly rpcUrl: string;
}

export interface LoopbackFacilitator {
  readonly url: string;
  close(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

export async function startLoopbackFacilitator(
  chains: readonly LoopbackChain[],
  signerPrivateKey: `0x${string}`,
): Promise<LoopbackFacilitator> {
  const bindings = new Map<string, FacilitatorBinding>(
    chains.map(({ network, rpcUrl }) => {
      const client = createLocalFacilitatorClient(
        rpcUrl,
        signerPrivateKey,
        Number(network.split(':')[1]),
      );
      return [network, createLocalFacilitatorBinding(client, network, () => false)];
    }),
  );

  const server: Server = createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/supported') {
      reply(200, {
        kinds: chains.map(({ network }) => ({ x402Version: 2, scheme: 'exact', network })),
        extensions: [],
        signers: {},
      });
      return;
    }
    const operation =
      req.url === '/verify' ? 'verify' : req.url === '/settle' ? 'settle' : undefined;
    if (req.method !== 'POST' || operation === undefined) {
      reply(404, { error: 'not found' });
      return;
    }
    readJson(req)
      .then(async (body) => {
        const requirements = body['paymentRequirements'] as { network: string };
        const binding = bindings.get(requirements.network);
        if (!binding) {
          reply(400, { isValid: false, invalidReason: 'unsupported_network' });
          return;
        }
        const session = binding.open();
        const payload = body['paymentPayload'] as never;
        reply(
          200,
          operation === 'verify'
            ? await session.verify(payload, requirements as never)
            : await session.settle(payload, requirements as never),
        );
      })
      .catch((err: unknown) => reply(500, { error: String(err) }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
