/**
 * In-memory implementation of the frozen `ResourceRegistry` interface.
 */
import type { ProtocolName } from '../domain/common.js';
import type { CommerceResource, ResourceRegistry } from '../domain/resource.js';
import { CommerceError } from '../errors/index.js';

export class ResourceRegistryImpl implements ResourceRegistry {
  private readonly byId = new Map<string, CommerceResource>();
  private readonly ordered: readonly CommerceResource[];

  constructor(resources: readonly CommerceResource[]) {
    for (const resource of resources) {
      if (this.byId.has(resource.id)) {
        throw new CommerceError('CONFIG_INVALID', `Duplicate resource id "${resource.id}"`, {
          details: { resourceId: resource.id },
        });
      }
      this.byId.set(resource.id, resource);
    }
    this.ordered = [...resources];
  }

  get(id: string): CommerceResource | undefined {
    return this.byId.get(id);
  }

  list(): readonly CommerceResource[] {
    return this.ordered;
  }

  listExposedVia(protocol: ProtocolName): readonly CommerceResource[] {
    return this.ordered.filter((resource) => resource.exposedVia.includes(protocol));
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }
}

/** Build a `ResourceRegistry` from a validated list of canonical resources. */
export function createResourceRegistry(resources: readonly CommerceResource[]): ResourceRegistry {
  return new ResourceRegistryImpl(resources);
}
