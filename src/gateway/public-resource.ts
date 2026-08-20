/**
 * Public (secret-free) projection of a `CommerceResource`.
 *
 * `handler.headers` may carry resolved backend secrets (e.g. an
 * `Authorization` value built from `${API_KEY}`) — never expose it on a
 * public discovery surface (`GET /api/resources`, `.well-known`).
 */
import type { CommerceResource } from '../core/index.js';

export interface PublicResource {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly method: string;
  readonly pricing: CommerceResource['pricing'];
  readonly exposedVia: readonly string[];
  readonly paymentMethods: readonly string[];
}

export function toPublicResource(resource: CommerceResource): PublicResource {
  return {
    id: resource.id,
    name: resource.name,
    ...(resource.description !== undefined ? { description: resource.description } : {}),
    ...(resource.inputSchema !== undefined ? { inputSchema: resource.inputSchema } : {}),
    ...(resource.outputSchema !== undefined ? { outputSchema: resource.outputSchema } : {}),
    method: resource.handler.method,
    pricing: resource.pricing,
    exposedVia: resource.exposedVia,
    paymentMethods: resource.paymentMethods,
  };
}
