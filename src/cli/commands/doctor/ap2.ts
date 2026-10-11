// AP2 checks: settings, trust lists, the replay store and the gated resources

// Constants and a descriptor only: the AP2 provider would pull the optional
// peers `jose`, `@sd-jwt/core` and `canonicalize` into the CLI bundle
import {
  AP2_CHECKOUT_MANDATE_VCT,
  AP2_CHECKOUT_PROFILE,
  AP2_SPEC_VERSION,
} from '../../../authorization/ap2/constants';
import { AP2_UNSUPPORTED } from '../../../authorization/ap2/descriptor';
import type { GatewayConfig } from '../../lib/config-client';
import { storeFileCheck } from './storage';
import type { DoctorCheck } from './types';

// Issuer ids and how many keys each carries. Never a key
function describeIssuers(
  label: string,
  issuers: readonly { readonly issuer: string; readonly keys: readonly unknown[] }[],
): string {
  const described = issuers
    .map(
      (entry) => `${entry.issuer} (${entry.keys.length} key${entry.keys.length === 1 ? '' : 's'})`,
    )
    .join(', ');
  return `${label} issuers: ${described}`;
}

export function ap2Checks(config: GatewayConfig | undefined): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  // 5d. AP2 authorization, from config and the pins. Verification keys are
  // public but still trust policy nobody asked this report to print, so only
  // issuer ids and key counts appear.
  const ap2 = config?.authorization?.ap2;
  if (config === undefined) {
    checks.push({ name: 'AP2', status: 'WARN', detail: 'skipped: config invalid' });
  } else if (ap2 === undefined || !ap2.enabled) {
    checks.push({ name: 'AP2', status: 'INFO', detail: 'disabled' });
  } else {
    checks.push({
      name: 'AP2',
      status: 'PASS',
      detail: `experimental · spec ${AP2_SPEC_VERSION} · mode ${ap2.mode} · ${AP2_CHECKOUT_MANDATE_VCT} · profile ${AP2_CHECKOUT_PROFILE} · clock skew ${ap2.clockSkewSeconds}s · mandate aud ${ap2.requireMandateAudience === true ? 'required' : 'optional'} · mandate exp ${ap2.requireMandateExpiry === true ? 'required' : 'optional'}`,
    });

    // Two lists, reported separately: signing the merchant's checkout
    // documents must not read as the power to issue mandates
    checks.push({
      name: 'AP2 trust',
      status: 'PASS',
      detail: `${describeIssuers('mandate', ap2.trust.mandateIssuers)} · ${describeIssuers('checkout', ap2.trust.checkoutIssuers)}`,
    });

    checks.push(
      storeFileCheck('AP2 replay store', ap2.replay.path, {
        inMemory:
          'every spent mandate is forgotten on restart, so one could authorize a second purchase',
        unwritable: 'no mandate could be recorded as spent',
      }),
    );

    // Resource ids, so an operator can see exactly which purchases now need a
    // mandate. An empty list means AP2 is configured and gating nothing.
    const gated = config.resources.filter((resource) =>
      resource.authorization?.required.includes('ap2'),
    );
    checks.push({
      name: 'AP2 resources',
      status: gated.length > 0 ? 'PASS' : 'WARN',
      detail:
        gated.length > 0
          ? gated.map((resource) => resource.id).join(', ')
          : 'AP2 is enabled but no resource requires it, so every purchase settles without a mandate',
    });

    checks.push({
      name: 'AP2 unsupported',
      status: 'INFO',
      detail: AP2_UNSUPPORTED.join(', '),
    });
  }
  return checks;
}
