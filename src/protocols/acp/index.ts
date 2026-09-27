/**
 * src/protocols/acp
 *
 * ACP (Agentic Commerce Protocol) adapter, experimental: serves the stable
 * checkout subset of the pinned `2026-04-17` snapshot at its mount, plus the
 * specification-fixed `/.well-known/acp.json`. `descriptor.ts` lists what it
 * does not do; `spec/` holds the vendored schema it validates against.
 */

export type { AcpAdapterOptions } from './adapter';
export { createAcpAdapter } from './adapter';
export { ACP_API_VERSION, ACP_SPEC_VERSION, ACP_WELL_KNOWN_PATH } from './constants';
