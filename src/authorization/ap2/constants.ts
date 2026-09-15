/**
 * Pinned AP2 identifiers and key policy.
 *
 * AP2 v0.2.0 (2026-04-28, commit b4587ac) is the tagged release this gateway
 * verifies against; unversioned `main` is never implemented against. Config,
 * the verifier and `doctor` all read these, so a bump lands in one place.
 */

export const AP2_SPEC_VERSION = '0.2.0';

/**
 * Autonomous mode needs open mandates, cnf-bound agent keys and constraint
 * evaluation over `checkout.line_items`. Half of that would be worse than a
 * declared Direct-only profile, so it is refused rather than partly served.
 */
export const AP2_MODES = ['direct'] as const;
export type Ap2Mode = (typeof AP2_MODES)[number];

/**
 * One entry, so `alg=none` and the HMAC family are excluded by construction
 * rather than by a check that has to remember them
 */
export const AP2_SIGNING_ALGORITHM = 'ES256';

/** The key type and curve ES256 implies. Any other pair is refused at load */
export const AP2_KEY_TYPE = 'EC';
export const AP2_JWK_CURVE = 'P-256';

/** Byte length of a P-256 coordinate, before base64url encoding */
export const AP2_JWK_COORDINATE_BYTES = 32;

/**
 * JWK members a verification key may carry.
 *
 * An allowlist, so private material (`d`) and anything naming a URL (`x5u`,
 * or a smuggled `jku`) is refused without this list having to name it. Keys
 * are configured inline and never fetched; see docs/security.md.
 */
export const AP2_JWK_MEMBERS = ['kty', 'crv', 'x', 'y', 'kid', 'alg', 'use'] as const;

/**
 * Compared against this literal, never as a prefix. `mandate.checkout.open.1`
 * carries spending constraints this release does not evaluate, so accepting it
 * would tell a buyer their limits were checked when nothing read them.
 */
export const AP2_CHECKOUT_MANDATE_VCT = 'mandate.checkout.1';

/**
 * The checkout profile every merchant checkout JWT must declare.
 *
 * Ours, not AP2's: AP2 leaves the checkout payload outside its scope, so the
 * claims a paid-resource invocation needs had to be specified somewhere.
 *
 * A bare name, matching the gateway's other wire identifiers
 * (`agent-commerce/delivery`, `agent-commerce/v1.0.0`). A profile id is a
 * namespace and is never dereferenced, so a URL would only tie the wire format
 * to a domain. Frozen once released: merchants sign it into every checkout JWT.
 */
export const AP2_CHECKOUT_PROFILE = 'agent-commerce/ap2/checkout/v1';

/**
 * Taken from the SD-JWT `_sd_alg`, which defaults to sha-256 when absent.
 * Anything else is refused rather than hashed as sha-256 anyway, which would
 * check a presentation under an algorithm it never claimed.
 */
export const AP2_DIGEST_ALGORITHM = 'sha-256';

/** Seconds of clock skew tolerated on mandate and checkout time claims */
export const AP2_DEFAULT_CLOCK_SKEW_SECONDS = 60;

/**
 * Skew wide enough to cover a mandate's validity window stops `exp` rejecting
 * anything. An operator needing more than five minutes has a clock to fix.
 */
export const AP2_MAX_CLOCK_SKEW_SECONDS = 300;
