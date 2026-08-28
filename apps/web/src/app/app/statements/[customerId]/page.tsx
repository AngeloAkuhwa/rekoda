import type { Metadata } from 'next';
import { Money } from '@/components/ui/Money';
import { reportsCustomerStatement } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { AppNav } from '../../AppNav';
import { SignOutButton } from '../../SignOutButton';
import { heldBy } from '@/lib/capabilities';

export const metadata: Metadata = {
  title: 'Customer statement',
  robots: { index: false, follow: false },
};

/**
 * One customer's account, as a statement (D1, PR-097).
 *
 * This page is the OTHER half of the receipt: a receipt acknowledges that
 * one payment was accepted, and this is where the account actually stands
 * after everything — invoices, payments, credits — in the order it
 * happened (spec §15). Numbers and figures only, never a name: the page
 * might be open on a market stall's counter.
 */
export default async function CustomerStatementPage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const { customerId } = await params;
  const { identity, token } = await requireSessionWithToken();
  const statement = await reportsCustomerStatement(token, customerId);

  const KIND_LABELS: Record<string, string> = {
    invoice: 'Invoice',
    payment: 'Payment received',
    credit_applied: 'Credit applied',
  };

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">Customer statement</p>
          <h1>Where this account stands</h1>
        </div>
        <SignOutButton />
      </header>

      <AppNav active="invoices" held={heldBy(identity)} />

      <div className="rk-card">
        <h2>Statement of account</h2>
        <p className="rk-fineprint">
          A receipt says one payment was accepted. This statement says how the whole account stands:
          every invoice, every payment and every credit, in the order they happened. Receipts live
          on the <a href="/app/receipts">receipts page</a>.
        </p>
        {statement.entries.length === 0 && statement.openingK === 0 ? (
          <p className="rk-fineprint">Nothing on this account yet.</p>
        ) : (
          <>
            <div className="rk-table-scroll">
              <table className="rk-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Entry</th>
                    <th>Reference</th>
                    <th className="rk-num">Amount</th>
                    <th className="rk-num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.entries.map((entry, index) => (
                    <tr key={`${entry.on}-${entry.reference}-${index}`}>
                      <td>{entry.on}</td>
                      <td>{KIND_LABELS[entry.kind] ?? entry.kind}</td>
                      <td>{entry.reference}</td>
                      <td className="rk-num">
                        <Money kobo={entry.amountK} />
                      </td>
                      <td className="rk-num">
                        <Money kobo={entry.balanceK} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="rk-fineprint">
              Balance now: <Money kobo={statement.closingK} />
            </p>
          </>
        )}
      </div>
    </section>
  );
}
