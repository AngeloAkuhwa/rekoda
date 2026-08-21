import type { Metadata } from 'next';
import { formatKobo } from '@rekoda/core';
import { Money } from '@/components/ui/Money';
import { reportsInvoices } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { AppNav } from '../AppNav';
import { CreditForm, type CreditableInvoice } from './CreditForm';
import { VoidForm } from './VoidForm';
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

  /* Only what CAN be voided is offered. An invoice with money against it is
   * corrected by refunding rather than reversing, and one already voided has
   * nothing left to withdraw. */
  const voidable = invoices
    .filter((invoice) => invoice.paidK === 0 && invoice.status !== 'voided')
    .map((invoice) => invoice.invoiceNumber);

  /* And the other half of the pair. A credit note reduces an invoice money HAS
   * arrived against, which is exactly the set the void refuses, so between the
   * two controls every invoice has one correction path and never both. */
  const creditable: CreditableInvoice[] = invoices
    .filter(
      (invoice) =>
        invoice.paidK > 0 && invoice.status !== 'voided' && invoice.creditedK < invoice.totalK,
    )
    .map((invoice) => ({
      invoiceNumber: invoice.invoiceNumber,
      creditableK: invoice.totalK - invoice.creditedK,
      label: `${invoice.invoiceNumber} · ${formatKobo(invoice.totalK - invoice.creditedK)} left to credit`,
    }));

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
                    <th>Credited</th>
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
                      {/* A credit note is a document raised against this row, and
                          the register is where a merchant looks for it. Without
                          this column a partly credited invoice is
                          indistinguishable from one nobody has touched. */}
                      <td>{invoice.creditedK === 0 ? '' : <Money kobo={invoice.creditedK} />}</td>
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
            {/* An accounting tool a merchant cannot correct is one they stop
                trusting. Nothing is deleted: the invoice stays, marked, and
                the books carry the sale and its reversal. */}
            <details className="rk-void">
              <summary>Void an invoice</summary>
              <p className="rk-fineprint">
                Use this when an invoice should never have gone out: the wrong customer, the wrong
                figure, a duplicate. The invoice stays in your records marked as voided, and your
                books show the sale and the reversal that cancelled it. Nothing is deleted.
              </p>
              <VoidForm voidable={voidable} />
            </details>

            {/* A separate control, because it is a separate instrument. The
                void withdraws a sale that should never have happened; this
                reduces one that did, and leaves the money the customer already
                sent exactly where it is. */}
            <details className="rk-void">
              <summary>Credit an invoice</summary>
              <p className="rk-fineprint">
                Use this when a customer has paid and something has to come back: goods returned, an
                overcharge, a dispute settled. The invoice stays, a numbered credit note is raised
                against it, and your books show the sale and the credit side by side. The money
                already in your account is not touched, so if you are giving cash back, record that
                separately as a payment out.
              </p>
              <CreditForm invoices={creditable} />
            </details>

            {/* The answer to "what happens to my records if I leave". A
                product that cannot be left has to be trusted blindly, and
                asking for that is worse than earning it. */}
            <p className="rk-fineprint">
              <a href="/app/export/invoices" download>
                Download all invoices as a spreadsheet (CSV)
              </a>
            </p>
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
    case 'credited':
      return 'Credited';
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
