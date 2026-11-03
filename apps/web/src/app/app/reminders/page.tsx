import type { Metadata } from 'next';
import { reminderBatches, reportsDebtors } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { heldBy } from '@/lib/capabilities';
import { canRecordTrade } from '@/lib/permissions';
import {
  SCHEDULE_AHEAD_DAYS,
  batchStateLabel,
  channelsLabel,
  invoicesCount,
  lagosDateTime,
  lagosLocalInput,
  newBatchView,
  remindersOffNotice,
} from '@/lib/reminder-copy';
import { Button } from '@/components/ui/Button';
import { AppNav } from '../AppNav';
import { SignOutButton } from '../SignOutButton';
import { NewBatchForm, type RemindableInvoice } from './NewBatchForm';
import styles from './reminders.module.css';

export const metadata: Metadata = {
  title: 'Reminders',
  robots: { index: false, follow: false },
};

/**
 * Customer payment reminders from the dashboard (REM-06, on REM-05's API).
 *
 * Capability: customer reminders (N1, OWN-43). Journey: the merchant reminds the customers who
 * owe, several at once, now or later, and sees what happened. Risk tier STANDARD: a preview names
 * every invoice and its outcome, then a plain yes. State model: the batch (scheduled, completed,
 * cancelled) and each recipient's reminder rows, as the API reports them.
 *
 * Like the debtors page, invoices only: no customer name is on this page.
 */
export default async function RemindersPage() {
  const { identity, token } = await requireSessionWithToken();
  const mayAct = canRecordTrade(identity.role);
  const [{ batches, released }, debtors] = await Promise.all([
    reminderBatches(token),
    reportsDebtors(token, true),
  ]);
  const now = new Date();

  const remindable: RemindableInvoice[] = debtors.rows.map((row) => ({
    invoiceNumber: row.invoiceNumber,
    balanceDueK: row.balanceDueK,
    daysOverdue: row.daysOverdue,
    dueLabel: row.dueDate ? `Due ${shortDate(row.dueDate)}` : 'No due date',
  }));

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">Reminders</p>
          <h1>Remind customers who owe you</h1>
        </div>
        <SignOutButton />
      </header>

      <AppNav active="reminders" held={heldBy(identity)} role={identity.role} />

      {mayAct ? (
        <div className="rk-card">
          <h2>Remind several customers</h2>
          <p className="rk-fineprint">
            Pick the unpaid invoices, choose how and when, and preview. Nothing is sent until you
            confirm. Each reminder names your business, quotes what is still owed and tells the
            customer how to pay you.
          </p>
          {newBatchView(released, remindable.length) === 'not_released' ? (
            <p className={`rk-dash-empty-line ${styles.spaced}`}>{remindersOffNotice()}</p>
          ) : newBatchView(released, remindable.length) === 'nothing_owed' ? (
            <p className={`rk-dash-empty-line ${styles.spaced}`}>
              Nobody owes you anything right now. Invoices with a balance appear here to remind the
              moment they are issued.
            </p>
          ) : (
            <NewBatchForm
              invoices={remindable}
              nowInput={lagosLocalInput(now)}
              maxInput={lagosLocalInput(
                new Date(now.getTime() + SCHEDULE_AHEAD_DAYS * 24 * 3_600_000),
              )}
            />
          )}
          {debtors.count > debtors.rows.length ? (
            <p className="rk-fineprint">
              Showing the oldest {debtors.rows.length} of {debtors.count} unpaid invoices.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="rk-card">
          <h2>Reminders</h2>
          <p className="rk-fineprint">
            Your access is view only, so you can see the reminders that were sent but not send or
            cancel them. The owner or a helper can.
          </p>
        </div>
      )}

      <div className="rk-card">
        <h2>Reminders you scheduled</h2>
        {batches.length === 0 ? (
          <p className={`rk-dash-empty-line ${styles.spaced}`}>
            {mayAct
              ? 'None yet. Pick unpaid invoices above to remind several customers at once.'
              : 'None yet.'}
          </p>
        ) : (
          <ul className={styles.rows} aria-label="Reminder batches">
            {batches.map((b) => (
              <li key={b.id} className={styles.row}>
                <div className={styles.rowHead}>
                  <a className={styles.batchLink} href={`/app/reminders/${b.id}`}>
                    {invoicesCount(b.itemCount)}, {lagosDateTime(b.scheduledFor)}
                  </a>
                  <span className={styles.status} data-tone="neutral">
                    {batchStateLabel(b.state, b.scheduledFor, now)}
                  </span>
                </div>
                <p className={styles.rowDetail}>
                  {channelsLabel(b.channels)}. {b.counts.sent} sent
                  {b.counts.notSent > 0 ? `, ${b.counts.notSent} not sent` : ''}
                  {b.counts.uncertain > 0 ? `, ${b.counts.uncertain} could not be confirmed` : ''}
                  {b.counts.pending > 0 ? `, ${b.counts.pending} waiting` : ''}
                  {b.counts.cancelled > 0 ? `, ${b.counts.cancelled} cancelled` : ''}.
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rk-card">
        <h2>One invoice at a time</h2>
        <p className="rk-fineprint">
          {mayAct
            ? 'Open an invoice to send one reminder now, see every reminder sent for it, or stop reminders for it.'
            : 'Open an invoice to see every reminder sent for it.'}
        </p>
        {debtors.rows.length === 0 ? null : (
          <form action="/app/reminders/invoice" method="get" className="rk-form">
            <div className={styles.openRow}>
              <div>
                <label htmlFor="oneInvoice" className="rk-sr-only">
                  Invoice
                </label>
                <select id="oneInvoice" name="number" className="rk-input" defaultValue="">
                  <option value="" disabled>
                    Choose an invoice
                  </option>
                  {debtors.rows.map((row) => (
                    <option key={row.invoiceNumber} value={row.invoiceNumber}>
                      {row.invoiceNumber}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit" variant="secondary">
                Open
              </Button>
            </div>
          </form>
        )}
        <p className="rk-fineprint">
          Reminders show the business phone and bank details you set in{' '}
          <a href="/app/settings#reminders">Settings</a>.
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
