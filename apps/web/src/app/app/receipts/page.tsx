import type { Metadata } from 'next';
import { Money } from '@/components/ui/Money';
import { reportsReceipts } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { AppNav } from '../AppNav';

export const metadata: Metadata = {
  title: 'Receipts',
  robots: { index: false, follow: false },
};

/**
 * The receipt register (MASTER-PLAN §5.3.7). A receipt exists here only
 * because a real payment was recorded against it — there is no path that
 * mints one otherwise (spec rule 12), which is what makes this page worth
 * showing a tax officer.
 */
export default async function ReceiptsPage() {
  const { token } = await requireSessionWithToken();
  const { receipts, count } = await reportsReceipts(token);

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">Receipts</p>
          <h1>Proof of every payment</h1>
        </div>
      </header>

      <AppNav active="receipts" />

      <div className="rk-card">
        <h2>Receipt register</h2>
        {receipts.length === 0 ? (
          <p className="rk-fineprint">
            No receipts yet. When a payment settles an invoice, the receipt is issued and numbered
            here automatically.
          </p>
        ) : (
          <>
            <div className="rk-table-scroll">
              <table className="rk-table">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Date</th>
                    <th>Amount</th>
                    <th>Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {receipts.map((receipt) => (
                    <tr key={receipt.receiptNumber}>
                      <td>{receipt.receiptNumber}</td>
                      <td>{shortDate(receipt.issuedAt)}</td>
                      <td>
                        <Money kobo={receipt.amountK} />
                      </td>
                      <td>{receipt.invoiceNumber ?? '(no invoice)'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="rk-fineprint">
              {count === 1 ? 'One receipt' : `${count} receipts`} all time
              {count > receipts.length ? ` · showing the latest ${receipts.length}` : ''}
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/** `12 Aug`, Lagos time, same as everywhere else on the dashboard. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Africa/Lagos',
  });
}
