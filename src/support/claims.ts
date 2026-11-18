/**
 * Read support status, feature status and exclusion names for descriptors,
 * discovery and `doctor`, without loading external packages.
 * `scripts/support-record.ts` validates records in tests and tooling; runtime
 * readers trust them.
 */
import { CommerceError } from '../core/errors';

/** The fields of a support record that runtime code reads */
export interface SupportClaims {
  readonly status: string;
  readonly features: readonly { readonly name: string; readonly status: string }[];
  readonly exclusions: readonly { readonly name: string }[];
}

export type FeatureStatus = 'supported' | 'experimental' | 'partial';

/** Maps `supported` to `stable` without changing the descriptor's status union */
export function descriptorStatus(record: SupportClaims): 'stable' | 'experimental' {
  return record.status === 'supported' ? 'stable' : 'experimental';
}

/** The strings a descriptor publishes in `unsupported` */
export function exclusionNames(record: SupportClaims): readonly string[] {
  return record.exclusions.map((exclusion) => exclusion.name);
}

export function featureStatus(record: SupportClaims, name: string): FeatureStatus {
  const feature = record.features.find((candidate) => candidate.name === name);
  if (feature === undefined) {
    throw new CommerceError('INTERNAL_ERROR', `support record has no feature "${name}"`);
  }
  return feature.status as FeatureStatus;
}
