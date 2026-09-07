/** ACP adapter (experimental) - see `src/protocols/acp/spec/` for the pinned snapshot. */
export {
  ACP_API_VERSION,
  ACP_CHECKOUT_OPERATIONS,
  ACP_OPERATION_INPUT_KEYS,
  ACP_SPEC_VERSION,
  ACP_WELL_KNOWN_PATH,
  type AcpCheckoutOperation,
} from './constants.js';
export {
  ACP_DEFINITIONS,
  type AcpDefinition,
  type AcpValidationFailure,
  validateAcpDocument,
} from './validation.js';
