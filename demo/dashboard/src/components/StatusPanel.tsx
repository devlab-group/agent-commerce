import { formatHealth, formatStatusLabel } from '../lib/format.js';
import type { AdapterDescriptor, AdapterWithHealth, WellKnownDocument } from '../lib/types.js';

export interface StatusPanelProps {
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
      <td>{adapter.capabilities.length > 0 ? adapter.capabilities.join(', ') : '—'}</td>
      <td className="unsupported">
        {adapter.unsupported !== undefined && adapter.unsupported.length > 0
          ? adapter.unsupported.join(', ')
          : '—'}
      </td>
    </tr>
  );
}

function DescriptorRow({ descriptor }: { readonly descriptor: AdapterDescriptor }) {
  return (
    <tr>
      <td>{descriptor.name}</td>
      <td className={statusClass(descriptor.status)}>{formatStatusLabel(descriptor.status)}</td>
      <td>—</td>
      <td>{descriptor.supportedSpec}</td>
      <td>{descriptor.capabilities.length > 0 ? descriptor.capabilities.join(', ') : '—'}</td>
      <td className="unsupported">
        {descriptor.unsupported !== undefined && descriptor.unsupported.length > 0
          ? descriptor.unsupported.join(', ')
          : '—'}
      </td>
    </tr>
  );
}

/**
 * `GET /.well-known/agent-commerce` — every adapter/provider/store's own
 * self-description. Never renders a green check for something an adapter
 * says it does not implement; `unsupported` is shown honestly alongside it.
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

  return (
    <section className="panel">
      <h2>Protocol &amp; payment status</h2>
      <p>
        {wellKnown.merchant.name} — gateway {wellKnown.gateway.implementationVersion} (
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
          <DescriptorRow descriptor={wellKnown.store} />
        </tbody>
      </table>

      <h3>x402 settlement</h3>
      {x402 === undefined || !x402.enabled ? (
        <p className="empty">
          x402 is not enabled — resources requiring payment cannot be delivered.
        </p>
      ) : (
        <table>
          <tbody>
            <tr>
              <th>Network</th>
              <td>{x402.network}</td>
            </tr>
            <tr>
              <th>Asset</th>
              <td>
                {x402.assetName} v{x402.assetVersion} ({x402.asset})
              </td>
            </tr>
            <tr>
              <th>Pays to</th>
              <td>
                <strong>{x402.payTo}</strong> — merchant-controlled, never the gateway
              </td>
            </tr>
            <tr>
              <th>Facilitator</th>
              <td>{x402.facilitator.mode === 'local' ? 'local (dev chain only)' : 'remote'}</td>
            </tr>
          </tbody>
        </table>
      )}
    </section>
  );
}
