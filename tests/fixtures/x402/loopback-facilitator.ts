/**
 * Test-only SDK `x402Facilitator` over HTTP on 127.0.0.1, to exercise the
 * gateway's remote path: EVM through the local binding on Anvil chains with
 * custom ids, Solana through the SDK's own scheme on a local validator. One
 * Solana facilitator serves every request, so the SDK's duplicate-settlement
 * cache is shared as a deployed facilitator's is. LOCAL DEVELOPMENT ONLY.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { KeyPairSigner } from '@solana/kit';
import { x402Facilitator } from '@x402/core/facilitator';
import type { Network } from '@x402/core/types';
import { toFacilitatorSvmSigner } from '@x402/svm';
import { registerExactSvmScheme } from '@x402/svm/exact/facilitator';
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

export interface LoopbackSolana {
  readonly network: string;
  readonly rpcUrl: string;
  /** Pays transaction fees; LOCAL DEVELOPMENT ONLY */
  readonly feePayer: KeyPairSigner;
}

export async function startLoopbackFacilitator(options: {
  readonly evm?: {
    readonly chains: readonly LoopbackChain[];
    readonly signerPrivateKey: `0x${string}`;
  };
  readonly svm?: LoopbackSolana;
}): Promise<LoopbackFacilitator> {
  const chains = options.evm?.chains ?? [];
  const bindings = new Map<string, FacilitatorBinding>(
    chains.map(({ network, rpcUrl }) => {
      const client = createLocalFacilitatorClient(
        rpcUrl,
        options.evm?.signerPrivateKey as `0x${string}`,
        Number(network.split(':')[1]),
      );
      return [network, createLocalFacilitatorBinding(client, network, () => false)];
    }),
  );
  const solana = options.svm;
  const svmFacilitator = solana
    ? registerExactSvmScheme(new x402Facilitator(), {
        signer: toFacilitatorSvmSigner(solana.feePayer, { defaultRpcUrl: solana.rpcUrl }),
        networks: solana.network as Network,
      })
    : undefined;

  const server: Server = createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/supported') {
      // The Solana kinds carry the fee payer, as the SDK reports them
      const svmSupported = svmFacilitator?.getSupported();
      reply(200, {
        kinds: [
          ...chains.map(({ network }) => ({ x402Version: 2, scheme: 'exact', network })),
          ...(svmSupported?.kinds.filter((kind) => kind.x402Version === 2) ?? []),
        ],
        extensions: [],
        signers: svmSupported?.signers ?? {},
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
        const payload = body['paymentPayload'] as never;
        if (svmFacilitator && requirements.network === solana?.network) {
          reply(
            200,
            operation === 'verify'
              ? await svmFacilitator.verify(payload, requirements as never)
              : await svmFacilitator.settle(payload, requirements as never),
          );
          return;
        }
        const binding = bindings.get(requirements.network);
        if (!binding) {
          reply(400, { isValid: false, invalidReason: 'unsupported_network' });
          return;
        }
        const session = binding.open();
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
