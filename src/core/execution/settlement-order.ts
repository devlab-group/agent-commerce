/**
 * Set on a payment requirement to run the backend before settlement.
 * The pipeline settles first unless this metadata value is `true`.
 */
export const SETTLE_AFTER_BACKEND_METADATA_KEY = 'settleAfterBackend';

/**
 * Set to `true` when the rail permits presenting an authorization again after
 * its attempt was rejected, which settled nothing; the chain still spends each
 * nonce once. The pipeline lets retries reclaim the rejected attempt;
 * otherwise, it refuses them as replays.
 */
export const REUSE_REJECTED_AUTHORIZATION_METADATA_KEY = 'reuseRejectedAuthorization';
