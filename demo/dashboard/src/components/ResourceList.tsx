import { formatPrice, formatProtocols } from '../lib/format.js';
import type { PublicResource } from '../lib/types.js';

export interface ResourceListProps {
  readonly resources: readonly PublicResource[];
  readonly error?: string;
}

/** `GET /api/resources` — every resource the gateway exposes, its price and its protocols. */
export function ResourceList({ resources, error }: ResourceListProps) {
  if (error !== undefined) {
    return (
      <section className="panel">
        <h2>Resources</h2>
        <p className="status-fail">{error}</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Resources ({resources.length})</h2>
      {resources.length === 0 ? (
        <p className="empty">No resources configured.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Price</th>
              <th>Protocols</th>
              <th>Payment methods</th>
            </tr>
          </thead>
          <tbody>
            {resources.map((resource) => (
              <tr key={resource.id}>
                <td>{resource.name}</td>
                <td>{formatPrice(resource.pricing)}</td>
                <td>{formatProtocols(resource.exposedVia)}</td>
                <td>
                  {resource.paymentMethods.length > 0 ? resource.paymentMethods.join(', ') : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
