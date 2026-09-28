import { formatTimestamp, shortenRequestId } from '../lib/format';
import type { CommerceReceipt } from '../lib/types';

interface ReceiptListProps {
  readonly receipts: readonly CommerceReceipt[];
  readonly error?: string;
  readonly highlightRequestId?: string;
  readonly onSelectRequestId?: (requestId: string) => void;
}

/**
 * A 2xx backend status marks delivery. Zero means no status was available,
 * as after a timeout or unreadable response. Other statuses are undelivered.
 * `doctor` uses the same rule for its count.
 */
function deliveryResult(receipt: CommerceReceipt): {
  readonly label: string;
  readonly ok: boolean;
} {
  const status = receipt.backendStatus;
  if (status >= 200 && status < 300) return { label: 'delivered', ok: true };
  return {
    label: status === 0 ? 'not delivered (no status)' : `not delivered (${status})`,
    ok: false,
  };
}

// The row that needs an operator's attention: charged, but nothing delivered
function needsAttention(receipt: CommerceReceipt, result: { readonly ok: boolean }): boolean {
  return receipt.payment?.status === 'settled' && !result.ok;
}

/**
 * `GET /api/receipts`: recent deliveries, newest first. Clicking a row selects
 * its `requestId`, which the event feed highlights too.
 */
export function ReceiptList({
  receipts,
  error,
  highlightRequestId,
  onSelectRequestId,
}: ReceiptListProps) {
  if (error !== undefined) {
    return (
      <section className="panel">
        <h2>Recent receipts</h2>
        <p className="status-fail">{error}</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Recent receipts ({receipts.length})</h2>
      {receipts.length === 0 ? (
        <p className="empty">No receipts yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Delivered</th>
              <th>Result</th>
              <th>Resource</th>
              <th>Request</th>
              <th>Amount</th>
              <th>Payment status</th>
              <th>Settlement ref</th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((receipt) => {
              const result = deliveryResult(receipt);
              const attention = needsAttention(receipt, result);
              return (
                <tr
                  key={receipt.id}
                  className={[
                    receipt.requestId === highlightRequestId ? 'highlight' : '',
                    attention ? 'attention' : '',
                    onSelectRequestId !== undefined ? 'clickable' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={
                    onSelectRequestId !== undefined
                      ? () => onSelectRequestId(receipt.requestId)
                      : undefined
                  }
                  title={
                    attention ? `Charged but not delivered: ${result.label}` : receipt.requestId
                  }
                >
                  <td>{formatTimestamp(receipt.deliveredAt)}</td>
                  <td className={result.ok ? undefined : 'status-fail'}>{result.label}</td>
                  <td>{receipt.resourceId}</td>
                  <td>{shortenRequestId(receipt.requestId)}</td>
                  <td>
                    {receipt.payment !== undefined
                      ? `${receipt.payment.amount} ${receipt.payment.currency}`
                      : 'Free'}
                  </td>
                  <td>{receipt.payment?.status ?? '-'}</td>
                  <td>{receipt.payment?.externalReference ?? '-'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
