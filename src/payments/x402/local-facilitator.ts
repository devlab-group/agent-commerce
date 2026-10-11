/**
 * In-process `x402Facilitator` using viem through `@x402/evm`.
 * EVM imports stay here so the remote binding can load without them.
 */
import { x402Facilitator } from '@x402/core/facilitator';
import type { Network } from '@x402/core/types';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { registerExactEvmScheme } from '@x402/evm/exact/facilitator';
import type { LocalFacilitatorClient } from './chain';
import {
  type FacilitatorBinding,
  type FacilitatorSession,
  SETTLEMENT_CONFIRMATION_TIMEOUT_MS,
} from './facilitator';

/**
 * Registers `exact`/EVM for one network, so a payload naming another chain
 * finds no matching scheme
 */
export function createLocalFacilitatorBinding(
  client: LocalFacilitatorClient,
  network: string,
  isTransportError: (err: unknown) => boolean,
): FacilitatorBinding {
  const build = (): { facilitator: x402Facilitator; failed: () => boolean } => {
    let failed = false;
    const watch = <T>(promise: Promise<T>): Promise<T> =>
      promise.catch((err: unknown) => {
        if (isTransportError(err)) failed = true;
        throw err;
      });

    // Watch the `FacilitatorEvmSigner` methods for transport failures and expose
    // `client.account.address` as the flat `address` the SDK expects
    const signer = {
      address: client.account.address,
      readContract: (args: Parameters<LocalFacilitatorClient['readContract']>[0]) =>
        watch(client.readContract(args)),
      verifyTypedData: (args: Parameters<LocalFacilitatorClient['verifyTypedData']>[0]) =>
        watch(client.verifyTypedData(args)),
      writeContract: (args: Parameters<LocalFacilitatorClient['writeContract']>[0]) =>
        watch(client.writeContract(args)),
      sendTransaction: (args: Parameters<LocalFacilitatorClient['sendTransaction']>[0]) =>
        watch(client.sendTransaction(args)),
      waitForTransactionReceipt: (
        args: Parameters<LocalFacilitatorClient['waitForTransactionReceipt']>[0],
      ) => watch(client.waitForTransactionReceipt(args)),
      getCode: (args: Parameters<LocalFacilitatorClient['getCode']>[0]) =>
        watch(client.getCode(args)),
    } as unknown as Parameters<typeof toFacilitatorEvmSigner>[0];

    // Bound receipt waits so a timeout returns `settlement_pending` with the
    // broadcast hash
    const facilitator = registerExactEvmScheme(new x402Facilitator(), {
      signer: toFacilitatorEvmSigner(signer, {
        confirmationTimeoutMs: SETTLEMENT_CONFIRMATION_TIMEOUT_MS,
      }),
      networks: network as Network,
    });

    return { facilitator, failed: () => failed };
  };

  return {
    kind: 'local',
    describe: 'local (in-process)',
    open(): FacilitatorSession {
      const { facilitator, failed } = build();
      return {
        verify: (payload, requirements) => facilitator.verify(payload, requirements),
        settle: (payload, requirements) => facilitator.settle(payload, requirements),
        transportFailed: failed,
      };
    },
  };
}
