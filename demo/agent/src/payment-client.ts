export interface CreatePaymentProofOptions {
  /** Buyer's dev-only private key. LOCAL DEVELOPMENT ONLY - DO NOT FUND */
  readonly buyerPrivateKey: `0x${string}`;
  /** One entry of `PaymentRequiredEnvelope.payment.accepts`, verbatim */
  readonly accepts: Readonly<Record<string, unknown>>;
}

export type CreatePaymentProof = (options: CreatePaymentProofOptions) => Promise<string>;

/**
 * Imports the x402 proof helper only when the demo signs, so a module that
 * fails to load fails the proof step with a named error. Tests inject a fake
 * and never load it.
 */
export const createPaymentProofDynamic: CreatePaymentProof = async (options) => {
  let mod: typeof import('../../../src/payments/x402');
  try {
    mod = await import('../../../src/payments/x402');
  } catch (err) {
    throw new Error(
      `src/payments/x402 could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return mod.createPaymentProof(options);
};
