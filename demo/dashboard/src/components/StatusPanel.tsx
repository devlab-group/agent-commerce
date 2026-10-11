import { formatHealth, formatStatusLabel } from '../lib/format';
import type { AdapterDescriptor, AdapterWithHealth, WellKnownDocument } from '../lib/types';

interface StatusPanelProps {
  readonly wellKnown?: WellKnownDocument;
  readonly error?: string;
}

function statusClass(status: string): string {
  if (status === 'pass' || status === 'stable') return 'status-pass';
  if (status === 'warn' || status === 'experimental') return 'status-warn';
  return 'status-fail';
}

function AdapterRow({ adapter }: { readonly adapter: AdapterWithHealth }) {
  return (
    <tr>
      <td>{adapter.name}</td>
      <td className={statusClass(adapter.status)}>{formatStatusLabel(adapter.status)}</td>
      <td className={statusClass(adapter.health.status)}>{formatHealth(adapter.health)}</td>
      <td>{adapter.supportedSpec}</td>
      <td>{adapter.capabilities.length > 0 ? adapter.capabilities.join(', ') : '-'}</td>
      <td className="unsupported">
        {adapter.unsupported !== undefined && adapter.unsupported.length > 0
          ? adapter.unsupported.join(', ')
          : '-'}
      </td>
    </tr>
  );
}

function DescriptorRow({ descriptor }: { readonly descriptor: AdapterDescriptor }) {
  return (
    <tr>
      <td>{descriptor.name}</td>
      <td className={statusClass(descriptor.status)}>{formatStatusLabel(descriptor.status)}</td>
      <td>-</td>
      <td>{descriptor.supportedSpec}</td>
      <td>{descriptor.capabilities.length > 0 ? descriptor.capabilities.join(', ') : '-'}</td>
      <td className="unsupported">
        {descriptor.unsupported !== undefined && descriptor.unsupported.length > 0
          ? descriptor.unsupported.join(', ')
          : '-'}
      </td>
    </tr>
  );
}

// EIP-3009 offers require token domain metadata; other offers may omit it
function describeAsset(offer: {
  readonly asset: string;
  readonly assetName?: string;
  readonly assetVersion?: string;
  readonly assetTransferMethod?: string;
}): string {
  const method = offer.assetTransferMethod === 'permit2' ? ', Permit2' : '';
  return offer.assetName !== undefined
    ? `${offer.assetName} v${offer.assetVersion ?? '?'} (${offer.asset}${method})`
    : `${offer.asset}${method === '' ? '' : ` (Permit2)`}`;
}

/**
 * Shows gateway components and their reported capabilities and limits from
 * `GET /.well-known/agent-commerce`
 */
export function StatusPanel({ wellKnown, error }: StatusPanelProps) {
  if (error !== undefined) {
    return (
      <section className="panel">
        <h2>Protocol &amp; payment status</h2>
        <p className="status-fail">{error}</p>
      </section>
    );
  }

  if (wellKnown === undefined) {
    return (
      <section className="panel">
        <h2>Protocol &amp; payment status</h2>
        <p className="empty">Loading…</p>
      </section>
    );
  }

  const x402 = wellKnown.payments.x402;
  // The rail's offers serve every resource without its own list
  const offerRows =
    x402 === undefined
      ? []
      : [
          ...(x402.options ?? [x402]).map((offer) => ({ offer, resource: 'default' })),
          ...Object.entries(x402.resourceOptions ?? {}).flatMap(([resource, list]) =>
            list.map((offer) => ({ offer, resource })),
          ),
        ];

  return (
    <section className="panel">
      <h2>Protocol &amp; payment status</h2>
      <p>
        {wellKnown.merchant.name}, gateway {wellKnown.gateway.implementationVersion} (
        {wellKnown.gateway.supportedSpec})
      </p>
      <table>
        <thead>
          <tr>
            <th>Adapter</th>
            <th>Status</th>
            <th>Health</th>
            <th>Spec</th>
            <th>Capabilities</th>
            <th>Unsupported</th>
          </tr>
        </thead>
        <tbody>
          {wellKnown.adapters.map((adapter) => (
            <AdapterRow key={adapter.name} adapter={adapter} />
          ))}
          {wellKnown.paymentProviders.map((provider) => (
            <DescriptorRow key={provider.name} descriptor={provider} />
          ))}
          {wellKnown.authorizationProviders.map((provider) => (
            <DescriptorRow key={provider.name} descriptor={provider} />
          ))}
          <DescriptorRow descriptor={wellKnown.store} />
        </tbody>
      </table>

      <h3>x402 settlement</h3>
      {x402 === undefined || !x402.enabled ? (
        <p className="empty">x402 is not enabled.</p>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>Resource</th>
                <th>Network</th>
                <th>Asset</th>
                <th>Pays to</th>
                <th>Health</th>
              </tr>
            </thead>
            <tbody>
              {offerRows.map(({ offer, resource }) => (
                <tr key={`${resource}|${offer.network}|${offer.asset}|${offer.payTo}`}>
                  <td>{resource}</td>
                  <td>{offer.network}</td>
                  <td>{describeAsset(offer)}</td>
                  <td>
                    <strong>{offer.payTo}</strong>
                  </td>
                  {'status' in offer && offer.status !== undefined ? (
                    <td className={statusClass(offer.status)}>{offer.status}</td>
                  ) : (
                    <td>-</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <table>
            <tbody>
              <tr>
                <th>Facilitator</th>
                <td>{x402.facilitator.mode === 'local' ? 'local (in-process)' : 'remote'}</td>
              </tr>
              <tr>
                <th>Deployment</th>
                <td>{x402.mode}</td>
              </tr>
              <tr>
                <th>Payment flow</th>
                <td>{x402.paymentFlow}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
