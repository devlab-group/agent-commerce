/**
 * Pinned AP2 identifiers and key policy.
 *
 * The pin is deliberate. AP2 v0.2.0 (released 2026-04-28, commit b4587ac) is
 * the tagged release this gateway verifies against; unversioned `main` is
 * never implemented against, because a mandate signed under one set of rules
 * has to be checked under that same set. Config, the verifier and `doctor`
 * all read these, so a bump lands in one place and changes every one of them
 * together.
 */

/** The only AP2 release this gateway verifies mandates against. */
export const AP2_SPEC_VERSION = '0.2.0';

/**
 * Operating modes implemented so far.
 *
 * Autonomous mode needs an open mandate, a cnf-bound agent key, selective
 * disclosures and deterministic constraint evaluation over
 * `checkout.line_items`. Half of that model would be worse than a clearly
 * declared Direct-only profile, so it is refused rather than partly served.
 */
export const AP2_MODES = ['direct'] as const;
export type Ap2Mode = (typeof AP2_MODES)[number];

/**
 * The only signature algorithm accepted, for mandates and for the merchant
 * checkout JWT alike.
 *
 * The allowlist holds one entry, so `alg=none` and the HMAC family are
 * excluded by construction rather than by a check that has to remember them.
 * AP2 v0.2 recommends non-deterministic signing for checkout JWTs, which
 * ES256 satisfies, and it matches the reference examples.
 */
export const AP2_SIGNING_ALGORITHM = 'ES256';

/** The key type and curve ES256 implies. Any other pair is refused at load. */
export const AP2_KEY_TYPE = 'EC';
export const AP2_JWK_CURVE = 'P-256';

/** Byte length of a P-256 coordinate, before base64url encoding. */
export const AP2_JWK_COORDINATE_BYTES = 32;

/**
 * JWK members a verification key may carry.
 *
 * An allowlist, so private material (`d`) and the members that point at a URL
 * (`x5u`, and `jku` if someone smuggles the header parameter in here) are
 * refused without this list having to name them. The static trust model
 * exists to rule out fetching a key from a location a mandate can influence;
 * see docs/security.md.
 */
export const AP2_JWK_MEMBERS = ['kty', 'crv', 'x', 'y', 'kid', 'alg', 'use'] as const;

/** Seconds of clock skew tolerated on mandate and checkout time claims. */
export const AP2_DEFAULT_CLOCK_SKEW_SECONDS = 60;

/**
 * Ceiling on configured skew.
 *
 * Skew wide enough to cover a mandate's whole validity window stops `exp`
 * from rejecting anything. Five minutes covers an unsynchronised server; an
 * operator needing more has a clock to fix, not a config value to raise.
 */
export const AP2_MAX_CLOCK_SKEW_SECONDS = 300;
