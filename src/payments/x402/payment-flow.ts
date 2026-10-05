/**
 * x402 exact-scheme flows, shared by the config loader and CLI.
 * The default `authorization` flow settles after a successful backend call;
 * `upfront` settles first.
 */
export const X402_PAYMENT_FLOWS = ['authorization', 'upfront'] as const;

export type X402PaymentFlow = (typeof X402_PAYMENT_FLOWS)[number];

export const X402_DEFAULT_PAYMENT_FLOW: X402PaymentFlow = 'authorization';
