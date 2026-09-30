/**
 * Secret-free projection of a `CommerceResource`, served by the public
 * `GET /api/resources`. `handler.headers` may carry resolved backend secrets,
 * such as an `Authorization` value built from `${API_KEY}`, so no handler
 * field except the method is copied.
 */
import type { CommerceResource } from '../core';

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
