/**
 * Test-only `x402Facilitator` on 127.0.0.1 exercises the gateway's remote path:
 * EVM uses the local binding on custom-id Anvil chains; Solana and NEAR use
 * SDK schemes on a local validator and sandbox. Each configured Solana or NEAR
 * facilitator is reused across requests to share its duplicate-settlement
 * cache, as in deployment. The smoke harness also uses it as a local
 * facilitator for public NEAR networks, over https.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { KeyPairString } from '@near-js/crypto';
import type { KeyPairSigner } from '@solana/kit';
import { x402Facilitator } from '@x402/core/facilitator';
import type { Network } from '@x402/core/types';
import { createFacilitatorNearSigner } from '@x402/near';
import { ExactNearScheme } from '@x402/near/exact/facilitator';
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

export interface LoopbackNear {
  readonly network: string;
  readonly rpcUrl: string;
  /** Submits delegate actions and pays their gas: a sandbox account, or a funded public-network one */
  readonly relayer: { readonly accountId: string; readonly secretKey: KeyPairString };
}

export async function startLoopbackFacilitator(options: {
  readonly evm?: {
    readonly chains: readonly LoopbackChain[];
    readonly signerPrivateKey: `0x${string}`;
  };
  readonly svm?: LoopbackSolana;
  readonly near?: LoopbackNear;
  /** Serves https with this certificate, since a mainnet gateway refuses a plain-HTTP facilitator */
  readonly tls?: { readonly key: string; readonly cert: string };
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
  // The SDK's own facilitators, by the network each serves
  const sdkFacilitators = new Map<string, x402Facilitator>();
  if (options.svm) {
    const { network, rpcUrl, feePayer } = options.svm;
    sdkFacilitators.set(
      network,
      registerExactSvmScheme(new x402Facilitator(), {
        signer: toFacilitatorSvmSigner(feePayer, { defaultRpcUrl: rpcUrl }),
        networks: network as Network,
      }),
    );
  }
  if (options.near) {
    const { network, rpcUrl, relayer } = options.near;
    const signer = createFacilitatorNearSigner({
      relayers: [relayer],
      rpcUrls: { [network]: rpcUrl },
    });
    sdkFacilitators.set(
      network,
      new x402Facilitator().register(network as Network, new ExactNearScheme(signer)),
    );
  }

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/supported') {
      // As the SDK reports them: Solana kinds carry the fee payer
      const sdk = [...sdkFacilitators.values()].map((facilitator) => facilitator.getSupported());
      reply(200, {
        kinds: [
          ...chains.map(({ network }) => ({ x402Version: 2, scheme: 'exact', network })),
          ...sdk.flatMap((supported) => supported.kinds.filter((kind) => kind.x402Version === 2)),
        ],
        extensions: [],
        signers: Object.assign({}, ...sdk.map((supported) => supported.signers)),
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
        const sdkFacilitator = sdkFacilitators.get(requirements.network);
        if (sdkFacilitator) {
          reply(
            200,
            operation === 'verify'
              ? await sdkFacilitator.verify(payload, requirements as never)
              : await sdkFacilitator.settle(payload, requirements as never),
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
  };

  const server = options.tls ? createHttpsServer(options.tls, handle) : createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `${options.tls ? 'https' : 'http'}://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
