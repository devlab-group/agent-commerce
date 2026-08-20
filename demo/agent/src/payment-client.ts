/**
 * Single seam for the demo agent's dependency on
 * `src/payments/x402`'s client-side `createPaymentProof`.
 *
 * The import is dynamic, not static, for the same reason as
 * `src/cli/lib/config-client.ts`: it isolates a resolution failure
 * to the one call site that needs it, and it lets `runDemoAgent`'s
 * orchestration logic be exercised in tests via dependency injection without
 * ever touching the real package.
 */
export interface CreatePaymentProofOptions {
  /** Buyer's dev-only private key. LOCAL DEVELOPMENT ONLY — DO NOT FUND. */
  readonly buyerPrivateKey: `0x${string}`;
  readonly rpcUrl: string;
  /** One entry from PaymentRequiredEnvelope.payment.accepts, verbatim. */
  readonly accepts: Readonly<Record<string, unknown>>;
}

export type CreatePaymentProof = (options: CreatePaymentProofOptions) => Promise<string>;

export const createPaymentProofDynamic: CreatePaymentProof = async (options) => {
  let mod: typeof import('../../../src/payments/x402/index.js');
  try {
    mod = await import('../../../src/payments/x402/index.js');
  } catch (err) {
    throw new Error(
      `src/payments/x402 could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return mod.createPaymentProof(options);
};
