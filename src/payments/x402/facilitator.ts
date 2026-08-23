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
import { HTTPFacilitatorClient } from '@x402/core/http';
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { registerExactEvmScheme } from '@x402/evm/exact/facilitator';
import { CommerceError } from '../../core/index.js';
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

/** The SDK's path-keyed auth-header shape. A flat object throws inside it. */
type AuthHeaderFactory = () => Promise<Record<string, Record<string, string>>>;

/**
 * CDP signs a fresh JWT per request over method + host + path, so a static
 * header cannot express it. `@coinbase/x402` does that signing, and is
 * imported dynamically: a static import would drag the whole CDP SDK — and its
 * Solana, axios and JOSE dependencies — into the `/x402` subpath for everyone,
 * including the majority who use a facilitator that needs no credential at all.
 *
 * The import is started at construction rather than on the first payment. A
 * missing peer must surface as an unhealthy provider before a buyer signs
 * anything, not as a failure inside verify() with their authorisation already
 * spent.
 */
function cdpAuthHeaders(apiKeyId: string, apiKeySecret: string): AuthHeaderFactory {
  const loading = import('@coinbase/x402').then(
    (mod) => mod.createCdpAuthHeaders(apiKeyId, apiKeySecret),
    (cause: unknown) => {
      throw new CommerceError(
        'CONFIG_INVALID',
        'x402 provider: facilitator.auth.type is "cdp", which needs the optional peer ' +
          '"@coinbase/x402". Install it (npm install @coinbase/x402), or use a facilitator ' +
          'that accepts a static token with auth.type "bearer".',
        { cause },
      );
    },
  );
  // Nothing awaits this until the first call; without a handler the rejection
  // above would be an unhandled promise rejection at startup.
  loading.catch(() => {});

  return async () => {
    const create = await loading;
    if (!create) {
      throw new CommerceError(
        'PAYMENT_PROVIDER_UNAVAILABLE',
        'x402 provider: @coinbase/x402 returned no auth-header factory',
      );
    }
    return (await create()) as Record<string, Record<string, string>>;
  };
}

/**
 * An HTTP facilitator.
 *
 * Auth headers are produced per request by the SDK client and never logged,
 * never echoed into `/.well-known`, and never included in `describe`.
 */
export function createRemoteFacilitatorBinding(
  options: RemoteFacilitatorOptions,
): FacilitatorBinding {
  const auth = options.auth;
  let createAuthHeaders: AuthHeaderFactory | undefined;
  if (auth.type === 'bearer') {
    createAuthHeaders = async () => {
      // The SDK requires a path-keyed object; a flat headers object throws
      // rather than silently dropping auth on every request.
      const headers = { Authorization: `Bearer ${auth.token}` };
      return { verify: headers, settle: headers, supported: headers };
    };
  } else if (auth.type === 'cdp') {
    createAuthHeaders = cdpAuthHeaders(auth.apiKeyId, auth.apiKeySecret);
  }

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
          // *Any* throw out of the SDK client means no verdict was obtained.
          // A verdict arrives as a returned `VerifyResponse`/`SettleResponse`,
          // including a negative one; the client only throws when it could not
          // reach the facilitator, could not authenticate to it, got a non-2xx,
          // or could not parse what came back. None of those are facts about
          // the payment, and recording them against the payer would blame the
          // buyer for our credential or the facilitator's outage.
          //
          // Deliberately not a predicate over error shapes: the SDK throws a
          // bare `Error` for an HTTP status (`Facilitator verify failed (401)`)
          // and a `FacilitatorResponseError` for a bad body, so matching on
          // type or message would have missed exactly the credential case that
          // matters most. For settle() this also preserves the indeterminate
          // reading — a timeout may have settled after we stopped waiting.
          failed = true;
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
