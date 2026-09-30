/**
 * Pinned AP2 identifiers and key policy.
 *
 * AP2 v0.2.0 (2026-04-28, commit b4587ac) is the tagged release this gateway
 * verifies against; unversioned `main` is never implemented against. Config,
 * the verifier and `doctor` all read these, so a bump lands in one place.
 */

export const AP2_SPEC_VERSION = '0.2.0';

/**
 * Direct only. Autonomous mode needs open mandates, cnf-bound agent keys and
 * constraint evaluation over `checkout.line_items`, none of which is
 * implemented, so it is refused rather than partly served.
 */
export const AP2_MODES = ['direct'] as const;
export type Ap2Mode = (typeof AP2_MODES)[number];

/**
 * A single algorithm, so `alg=none` and the HMAC family are excluded by
 * construction rather than by a denylist
 */
export const AP2_SIGNING_ALGORITHM = 'ES256';

/** The key type and curve ES256 implies. Any other pair is refused at load */
export const AP2_KEY_TYPE = 'EC';
export const AP2_JWK_CURVE = 'P-256';

/** Byte length of a P-256 coordinate, before base64url encoding */
export const AP2_JWK_COORDINATE_BYTES = 32;

/**
 * JWK members a verification key may carry. An allowlist, so private material
 * (`d`) and URL members (`x5u`, `jku`) are refused without the list naming
 * them. Keys are configured inline and never fetched; see docs/security.md.
 */
export const AP2_JWK_MEMBERS = ['kty', 'crv', 'x', 'y', 'kid', 'alg', 'use'] as const;

/**
 * Compared against this literal, never as a prefix. `mandate.checkout.open.1`
 * carries spending constraints nothing here evaluates, so accepting it would
 * tell a buyer their limits were checked when nothing read them.
 */
export const AP2_CHECKOUT_MANDATE_VCT = 'mandate.checkout.1';

/**
 * Merchant checkout JWTs declare this gateway-specific profile; AP2 leaves
 * the checkout payload out of scope. The identifier is a namespace that
 * clients do not dereference. Merchants sign it into each checkout JWT, so
 * changing the expected value would reject previously signed JWTs.
 */
export const AP2_CHECKOUT_PROFILE = 'agent-commerce/ap2/checkout/v1';

/**
 * The only accepted SD-JWT `_sd_alg` (an absent one means sha-256). Any other
 * value is refused rather than hashed as sha-256, which would check a
 * presentation under an algorithm it never claimed.
 */
export const AP2_DIGEST_ALGORITHM = 'sha-256';

/** Seconds of clock skew tolerated on mandate and checkout time claims */
export const AP2_DEFAULT_CLOCK_SKEW_SECONDS = 60;

/**
 * Skew as wide as a mandate's validity window would stop `exp` rejecting
 * anything. An operator who needs more than five minutes has a clock to fix.
 */
export const AP2_MAX_CLOCK_SKEW_SECONDS = 300;
