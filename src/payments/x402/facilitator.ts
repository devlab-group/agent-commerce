/**
 * The facilitator verifies an authorization and broadcasts the transfer. Two
 * kinds sit behind one interface, both driving the SDK's own code:
 *
 *   local   the SDK's in-process `x402Facilitator`, signing against a dev node
 *   remote  the SDK's HTTP facilitator client, with or without a credential
 *
 * Each verify or settle call opens its own session so that `transportFailed()`
 * covers one request only: concurrent payments must not see each other's
 * transport failures.
 */
import { x402Facilitator } from '@x402/core/facilitator';
import { HTTPFacilitatorClient } from '@x402/core/http';
import {
  type Network,
  type PaymentPayload,
  type PaymentRequirements,
  SettleError,
  type SettleResponse,
  VerifyError,
  type VerifyResponse,
} from '@x402/core/types';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { registerExactEvmScheme } from '@x402/evm/exact/facilitator';
import { CommerceError } from '../../core';
import type { LocalFacilitatorClient } from './chain';
import type { FacilitatorAuth } from './guardrails';

/** One verify or one settle, with its own transport-failure flag */
export interface FacilitatorSession {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
  /**
   * True when the call produced no verdict: the local binding sets it when an
   * RPC call to the chain fails in transport, the remote binding on every
   * throw other than a 400 refusal of a verify or a settle.
   *
   * The SDK's `exact`/EVM scheme reports its own RPC errors as ordinary
   * verification failures: an unreachable node comes back as
   * `invalid_exact_evm_signature`. Without this flag the buyer would be told
   * their signature is bad for a payment nothing checked.
   */
  transportFailed(): boolean;
}

export interface SupportedKind {
  readonly x402Version: number;
  readonly scheme: string;
  readonly network: string;
}

interface BindingBase {
  /** Human-readable, never a credential */
  readonly describe: string;
  open(): FacilitatorSession;
}

export type FacilitatorBinding =
  | (BindingBase & { readonly kind: 'local' })
  | (BindingBase & {
      readonly kind: 'remote';
      /** What the facilitator says it can settle. Used by health(), not by the payment path */
      supported(): Promise<readonly SupportedKind[]>;
    });

// Bounds each receipt wait of the in-process facilitator, and each request to a
// remote one
const SETTLEMENT_CONFIRMATION_TIMEOUT_MS = 60_000;

/**
 * An in-process `x402Facilitator` with the `exact`/EVM scheme registered for
 * one network rather than an `eip155:*` wildcard, so a payload naming another
 * chain finds no scheme at all
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

    // Exactly the `FacilitatorEvmSigner` surface, so every call the SDK makes is
    // watched. `toFacilitatorEvmSigner` wants a flat `address`, which viem
    // keeps on `client.account`.
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

    // `confirmationTimeoutMs` turns a lost receipt wait into `settlement_pending`
    // with the broadcast hash, instead of a discarded broadcast
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

export interface RemoteFacilitatorOptions {
  readonly url: string;
  readonly auth: FacilitatorAuth;
}

// The SDK's path-keyed auth-header shape. A flat object throws inside it
type AuthHeaderFactory = () => Promise<Record<string, Record<string, string>>>;

/**
 * CDP needs a fresh JWT per request over method, host and path, which a static
 * header cannot express. The optional peer `@coinbase/x402` does the signing.
 * It is imported dynamically, so only `auth.type: cdp` pulls in the CDP SDK and
 * its Solana, axios and JOSE dependencies.
 *
 * The import starts at construction, so a missing peer fails the health check
 * before any payment needs it. A payment that arrives first fails as
 * `PAYMENT_PROVIDER_UNAVAILABLE`, never as a rejection blamed on the buyer.
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
  // Nothing awaits this before the first call, so without a handler a failed
  // import would be an unhandled rejection at startup
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
 * A 400 from `/verify` whose body names an `invalidReason` is the facilitator
 * refusing the payment, so it returns as an invalid verdict. The SDK throws it
 * as a `VerifyError`, which keeps the status and reason but not `isValid`.
 * A 400 without a reason and every other status, 401, 403, 429 and 5xx
 * included, are rethrown as "no verdict".
 */
function verdictFromVerifyError(err: unknown): VerifyResponse {
  if (
    err instanceof VerifyError &&
    err.statusCode === 400 &&
    typeof err.invalidReason === 'string'
  ) {
    return {
      isValid: false,
      invalidReason: err.invalidReason,
      ...(err.payer !== undefined ? { payer: err.payer } : {}),
    };
  }
  throw err;
}

/**
 * Treat a remote 400 as a refusal only when it names a reason and no
 * transaction. A transaction may have broadcast; other errors have no
 * verdict. `SettleError` does not retain the response's `success`.
 */
function verdictFromSettleError(err: unknown, network: Network): SettleResponse {
  if (
    err instanceof SettleError &&
    err.statusCode === 400 &&
    typeof err.errorReason === 'string' &&
    err.errorReason !== '' &&
    !err.transaction
  ) {
    return {
      success: false,
      errorReason: err.errorReason,
      transaction: '',
      network: err.network ?? network,
      ...(err.payer !== undefined ? { payer: err.payer } : {}),
    };
  }
  throw err;
}

/**
 * An HTTP facilitator. The SDK client produces the auth headers per request;
 * this module never logs them, and they appear neither in `/.well-known` nor
 * in `describe`.
 */
export function createRemoteFacilitatorBinding(
  options: RemoteFacilitatorOptions,
): FacilitatorBinding {
  const auth = options.auth;
  let createAuthHeaders: AuthHeaderFactory | undefined;
  if (auth.type === 'bearer') {
    createAuthHeaders = async () => {
      // Path-keyed, as the SDK requires (see `AuthHeaderFactory`)
      const headers = { Authorization: `Bearer ${auth.token}` };
      return { verify: headers, settle: headers, supported: headers };
    };
  } else if (auth.type === 'cdp') {
    createAuthHeaders = cdpAuthHeaders(auth.apiKeyId, auth.apiKeySecret);
  }

  const client = new HTTPFacilitatorClient({
    url: options.url,
    timeoutMs: SETTLEMENT_CONFIRMATION_TIMEOUT_MS,
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
          // After known 400 refusals, a throw gives no verdict. It may be
          // transport or authentication failure; settlement may have broadcast.
          // Do not record it as a payer refusal.
          failed = true;
          throw err;
        }
      };
      return {
        verify: (payload, requirements) =>
          watch(() => client.verify(payload, requirements).catch(verdictFromVerifyError)),
        settle: (payload, requirements) =>
          watch(() =>
            client
              .settle(payload, requirements)
              .catch((err: unknown) => verdictFromSettleError(err, requirements.network)),
          ),
        transportFailed: () => failed,
      };
    },
    async supported(): Promise<readonly SupportedKind[]> {
      const response = await client.getSupported();
      return response.kinds as readonly SupportedKind[];
    },
  };
}
