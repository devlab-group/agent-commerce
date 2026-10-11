/**
 * SDK clients sign smoke payments as real buyers would, keeping buyer keys
 * outside the gateway.
 */
import { createKeyPairSignerFromBytes, getBase58Encoder } from '@solana/kit';
import { x402Client } from '@x402/core/client';
import type { Network, PaymentRequired } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { createClientNearSigner } from '@x402/near';
import { ExactNearScheme } from '@x402/near/exact/client';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import type { SmokeSettings, SmokeTarget } from './targets';

// solana-keygen writes a JSON array of 64 bytes; wallets export base58
function solanaSigner(secret: string) {
  const bytes = secret.startsWith('[')
    ? Uint8Array.from(JSON.parse(secret) as number[])
    : getBase58Encoder().encode(secret);
  return createKeyPairSignerFromBytes(bytes);
}

/** The buyer as its chain names it: an address, a wallet or an account */
export async function buyerIdentity(target: SmokeTarget, settings: SmokeSettings): Promise<string> {
  if (target.family === 'evm')
    return privateKeyToAccount(settings.buyerKey as `0x${string}`).address;
  if (target.family === 'svm') return (await solanaSigner(settings.buyerKey)).address;
  return settings.buyerAccount as string;
}

/**
 * Signs a payment for the challenge's offer, returned as the
 * `PAYMENT-SIGNATURE` header value. The client keeps its default spend
 * controls: default assets only, at most $1 per payment.
 */
export async function signPayment(
  target: SmokeTarget,
  settings: SmokeSettings,
  offered: PaymentRequired,
): Promise<string> {
  const client = new x402Client();
  const network = target.network as Network;
  if (target.family === 'evm') {
    registerExactEvmScheme(client, {
      signer: privateKeyToAccount(settings.buyerKey as `0x${string}`),
      networks: [network],
    });
  } else if (target.family === 'svm') {
    client.register(
      network,
      new ExactSvmScheme(await solanaSigner(settings.buyerKey), { rpcUrl: settings.rpcUrl }),
    );
  } else {
    client.register(
      network,
      new ExactNearScheme(
        createClientNearSigner({
          accountId: settings.buyerAccount as string,
          secretKey: settings.buyerKey as `ed25519:${string}`,
          rpcUrls: { [network]: settings.rpcUrl },
        }),
      ),
    );
  }
  const payload = await client.createPaymentPayload(offered);
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}
