import type { Metadata } from 'next';
import { Money } from '@/components/ui/Money';
import { reportsDebtors } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { AppNav } from '../AppNav';
import { SignOutButton } from '../SignOutButton';
import { heldBy } from '@/lib/capabilities';

export const metadata: Metadata = {
  title: 'Debtors',
  robots: { index: false, follow: false },
};

/**
 * Everyone who owes, in one place (fix-plan 5, H2c).
 *
 * The overview strip shows six and used to end with "ask on WhatsApp",
 * which sent a merchant out of their own dashboard to read their own
 * receivables. Debts are listed by invoice, not by name, for the same
 * reason the chat answer is: no customer name has any business on a page
 * that might be open on a market stall's counter.
 */
export default async function DebtorsPage() {
  const { identity, token } = await requireSessionWithToken();
  const debtors = await reportsDebtors(token, true);

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">Debtors</p>
          <h1>Who still owes you</h1>
        </div>
        <SignOutButton />
      </header>

      <AppNav active="debtors" held={heldBy(identity)} />

      <div className="rk-card">
        <h2>Outstanding, oldest debt first</h2>
        {debtors.rows.length === 0 ? (
          <p className="rk-fineprint">
            Nobody owes you anything right now. Invoices with a balance land here the moment they
            are issued.
          </p>
        ) : (
          <>
            <p className="rk-fineprint">
              <Money kobo={debtors.totalK} /> outstanding across{' '}
              {debtors.count === 1 ? 'one invoice' : `${debtors.count} invoices`}. Record a payment
              on the <a href="/app/invoices">invoices page</a>, or send a reminder from WhatsApp
              with <strong>remind about INV-…</strong>
            </p>
            <div className="rk-table-scroll">
              <table className="rk-table">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Issued</th>
                    <th>Due</th>
                    <th>Late by</th>
                    <th className="rk-num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {debtors.rows.map((row) => (
                    <tr key={row.invoiceNumber}>
                      <td>{row.invoiceNumber}</td>
                      <td>{shortDate(row.issuedAt)}</td>
                      <td>{row.dueDate ? shortDate(row.dueDate) : 'No due date'}</td>
                      <td>
                        {row.daysOverdue > 0
                          ? `${row.daysOverdue} ${row.daysOverdue === 1 ? 'day' : 'days'}`
                          : ''}
                      </td>
                      <td className="rk-num">
                        <Money kobo={row.balanceDueK} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {debtors.count > debtors.rows.length ? (
              <p className="rk-fineprint">
                Showing the oldest {debtors.rows.length} of {debtors.count}. Clearing these brings
                the ones behind them onto the page.
              </p>
            ) : null}
          </>
        )}
        <p className="rk-fineprint">
          No names on this page on purpose: it may be open where customers can see it. WhatsApp
          answers <strong>who owes me</strong> the same way, by invoice.
        </p>
      </div>
    </section>
  );
}

/** `12 Aug 2026`, Lagos, same as every register. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Africa/Lagos',
  });
}
