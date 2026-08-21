import type { Metadata } from 'next';
import { Money } from '@/components/ui/Money';
import { reportsInvoices } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { AppNav } from '../AppNav';
import { SignOutButton } from '../SignOutButton';

export const metadata: Metadata = {
  title: 'Invoices',
  robots: { index: false, follow: false },
};

/**
 * The invoice register (MASTER-PLAN §5.3.7): every invoice the business has
 * issued, newest first, with what it billed, what came in and what is still
 * owed. Numbers and figures only — a customer is never named on this page,
 * because invoice records reach the dashboard tokenised and stay that way.
 */
export default async function InvoicesPage() {
  const { token } = await requireSessionWithToken();
  const { invoices, count, outstandingK } = await reportsInvoices(token);

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">Invoices</p>
          <h1>Everything you have billed</h1>
        </div>
        <SignOutButton />
      </header>

      <AppNav active="invoices" />

      <div className="rk-card">
        <h2>Invoice register</h2>
        {invoices.length === 0 ? (
          <p className="rk-fineprint">
            No invoices yet. Record a sale in chat and the invoice appears here, numbered and ready
            to send.
          </p>
        ) : (
          <>
            <div className="rk-table-scroll">
              <table className="rk-table">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Issued</th>
                    <th>Due</th>
                    <th>Status</th>
                    <th>Total</th>
                    <th>Paid</th>
                    <th>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((invoice) => (
                    <tr key={invoice.invoiceNumber}>
                      <td>{invoice.invoiceNumber}</td>
                      <td>{shortDate(invoice.issuedAt)}</td>
                      <td>{invoice.dueDate ? shortDate(invoice.dueDate) : 'not agreed'}</td>
                      {/* Late is a status a merchant acts on, so it wins the
                          column over "issued" or "partially paid" — those are
                          still legible from the Paid and Balance figures. */}
                      <td>
                        {invoice.daysOverdue > 0
                          ? `${invoice.daysOverdue} ${invoice.daysOverdue === 1 ? 'day' : 'days'} late`
                          : statusWord(invoice.status)}
                      </td>
                      <td>
                        <Money kobo={invoice.totalK} />
                      </td>
                      <td>{invoice.paidK === 0 ? 'nothing' : <Money kobo={invoice.paidK} />}</td>
                      <td>
                        {invoice.balanceDueK === 0 ? (
                          'settled'
                        ) : (
                          <Money kobo={invoice.balanceDueK} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="rk-fineprint">
              {count === 1 ? 'One invoice' : `${count} invoices`} all time
              {outstandingK > 0 ? (
                <>
                  {' · '}
                  <Money kobo={outstandingK} /> still owed to you
                </>
              ) : (
                ' · nothing outstanding'
              )}
              {count > invoices.length ? ` · showing the latest ${invoices.length}` : ''}
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/** Invoice states, said the way a merchant would say them. */
function statusWord(status: string): string {
  switch (status) {
    case 'issued':
      return 'Awaiting payment';
    case 'partially_paid':
      return 'Partly paid';
    case 'paid':
      return 'Paid';
    case 'voided':
      return 'Voided';
    default:
      return status;
  }
}

/** `12 Aug`, Lagos time, same as everywhere else on the dashboard. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Africa/Lagos',
  });
}
