/**
 * The facilitator seam.
 *
 * A facilitator is whatever verifies an authorisation and broadcasts the
 * transfer. This gateway supports two, behind one interface:
 *
 *   local   the SDK's in-process `x402Facilitator` signing against a dev node
 *   remote  an HTTP facilitator, with or without a credential
 *
 * Both are the SDK's own `FacilitatorClient` contract underneath, so neither
 * is a bespoke reimplementation of the protocol — the local one is the same
 * code a hosted facilitator runs, pointed at the local chain.
 *
 * A *session* is opened per verify/settle call rather than reused, because
 * `transportFailed()` has to be scoped to one request: two concurrent
 * payments must not see each other's transport failures. The cost is an
 * object literal against an RPC or HTTP round-trip.
 */
import { x402Facilitator } from '@x402/core/facilitator';
import { FacilitatorResponseError, HTTPFacilitatorClient } from '@x402/core/http';
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { registerExactEvmScheme } from '@x402/evm/exact/facilitator';
import type { LocalFacilitatorClient } from './chain.js';
import type { FacilitatorAuth } from './guardrails.js';

/** One verify or one settle, with its own transport-failure flag. */
export interface FacilitatorSession {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
  /**
   * True when the call failed to reach the facilitator (or the chain behind
   * it) rather than producing a verdict.
   *
   * The SDK's `exact`/EVM scheme catches its own RPC errors and reports them
   * as an ordinary verification failure — an unreachable node comes back as
   * `invalid_exact_evm_signature`. Fail-closed still holds, but the buyer is
   * told their signature is bad and the attempt is recorded as their fault,
   * when nothing about their payment was ever checked. This flag is how the
   * provider tells "we looked and it was wrong" apart from "we could not
   * look".
   */
  transportFailed(): boolean;
}

export interface SupportedKind {
  readonly x402Version: number;
  readonly scheme: string;
  readonly network: string;
}

export interface FacilitatorBinding {
  readonly kind: 'local' | 'remote';
  /** Human-readable, never a credential. */
  readonly describe: string;
  open(): FacilitatorSession;
  /** What the facilitator says it can settle. Used by health(), not by the payment path. */
  supported(): Promise<readonly SupportedKind[]>;
}

/** Bounds every receipt wait the in-process facilitator performs. */
export const SETTLEMENT_CONFIRMATION_TIMEOUT_MS = 60_000;

/**
 * An in-process `x402Facilitator` with the `exact`/EVM scheme registered
 * against exactly one network.
 *
 * One network, not the `eip155:*` wildcard the SDK would otherwise derive: a
 * payload naming some other chain must find no facilitator at all rather than
 * reaching a scheme that would then have to reject it.
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

    // Exactly the `FacilitatorEvmSigner` surface, so the wrapper covers every
    // call the SDK can make. `toFacilitatorEvmSigner` wants a flat `address`,
    // which viem carries on `client.account` instead.
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

    // `confirmationTimeoutMs` is what turns a lost receipt wait into
    // `settlement_pending` + the broadcast hash instead of a discarded broadcast.
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
    async supported(): Promise<readonly SupportedKind[]> {
      return build().facilitator.getSupported().kinds;
    },
  };
}

export interface RemoteFacilitatorOptions {
  readonly url: string;
  readonly auth: FacilitatorAuth;
  readonly timeoutMs?: number;
}

/**
 * An HTTP facilitator.
 *
 * Auth headers are produced per request by the SDK client and never logged,
 * never echoed into `/.well-known`, and never included in `describe`.
 */
export function createRemoteFacilitatorBinding(
  options: RemoteFacilitatorOptions,
  isTransportError: (err: unknown) => boolean,
): FacilitatorBinding {
  const auth = options.auth;
  const createAuthHeaders =
    auth.type === 'bearer'
      ? async (): Promise<Record<string, Record<string, string>>> => {
          // The SDK requires a path-keyed object; a flat headers object throws
          // rather than silently dropping auth on every request.
          const headers = { Authorization: `Bearer ${auth.token}` };
          return { verify: headers, settle: headers, supported: headers };
        }
      : undefined;

  const client = new HTTPFacilitatorClient({
    url: options.url,
    timeoutMs: options.timeoutMs ?? SETTLEMENT_CONFIRMATION_TIMEOUT_MS,
    ...(createAuthHeaders ? { createAuthHeaders } : {}),
  });

  return {
    kind: 'remote',
    describe: `remote ${new URL(options.url).origin} (auth=${auth.type})`,
    open(): FacilitatorSession {
      let failed = false;
      const watch = async <T>(call: () => Promise<T>): Promise<T> => {
        try {
          return await call();
        } catch (err) {
          // A facilitator that timed out or answered with something
          // unparseable produced no verdict. Treating either as a payment
          // failure would blame the buyer for the facilitator being down —
          // and for settle(), a timeout is explicitly indeterminate: the
          // transfer may have gone through after we stopped waiting.
          if (err instanceof FacilitatorResponseError || isTransportError(err)) failed = true;
          throw err;
        }
      };
      return {
        verify: (payload, requirements) => watch(() => client.verify(payload, requirements)),
        settle: (payload, requirements) => watch(() => client.settle(payload, requirements)),
        transportFailed: () => failed,
      };
    },
    async supported(): Promise<readonly SupportedKind[]> {
      const response = await client.getSupported();
      return response.kinds as readonly SupportedKind[];
    },
  };
}
