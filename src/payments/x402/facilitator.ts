/**
 * Shared facilitator interface and remote HTTP binding. The in-process EVM
 * binding lives in `local-facilitator.ts` to keep EVM peers out of this module.
 * `@x402/core` loads statically; `@coinbase/x402` loads only for `auth.type: cdp`.
 * Both bindings use the SDK to verify authorizations and broadcast transfers.
 *
 * Each verify or settle call gets a session with its own `transportFailed()`
 * flag, isolating concurrent payments' transport failures.
 */
import { HTTPFacilitatorClient } from '@x402/core/http';
import {
  type Network,
  type PaymentPayload,
  type PaymentRequirements,
  SettleError,
  type SettleResponse,
  type SupportedResponse,
  VerifyError,
  type VerifyResponse,
} from '@x402/core/types';
import { CommerceError } from '../../core';
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

interface BindingBase {
  /** Human-readable, never a credential */
  readonly describe: string;
  open(): FacilitatorSession;
}

export type FacilitatorBinding =
  | (BindingBase & { readonly kind: 'local' })
  | (BindingBase & {
      readonly kind: 'remote';
      /**
       * SDK-parsed `/supported` response, including kinds and their `extra`
       * (such as Solana's fee payer), extensions and signers. Used by health(),
       * not by the payment path
       */
      supported(): Promise<SupportedResponse>;
    });

/** Bounds each receipt wait of the in-process facilitator, and each request to a remote one */
export const SETTLEMENT_CONFIRMATION_TIMEOUT_MS = 60_000;

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
    supported: () => client.getSupported(),
  };
}
