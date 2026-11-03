import type { Metadata } from 'next';
import { Money } from '@/components/ui/Money';
import { reminderHistory, reportsDebtors } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { heldBy } from '@/lib/capabilities';
import { canRecordTrade } from '@/lib/permissions';
import {
  channelName,
  lagosDateTime,
  reminderStatusDetail,
  reminderStatusLabel,
} from '@/lib/reminder-copy';
import { AppNav } from '../../AppNav';
import { SignOutButton } from '../../SignOutButton';
import { StatusText } from '../StatusText';
import { SendReminderForm } from './SendReminderForm';
import { StopRemindersForm } from './StopRemindersForm';
import styles from '../reminders.module.css';

export const metadata: Metadata = {
  title: 'Invoice reminders',
  robots: { index: false, follow: false },
};

/**
 * One invoice's reminders (REM-06): send one now, read every one sent, stop or resume them.
 * Everyone on the team reads the history; sending and stopping are the owner's and a helper's,
 * and the API refuses them to anyone else whatever this page shows.
 */
export default async function InvoiceRemindersPage({
  searchParams,
}: {
  searchParams: Promise<{ number?: string | string[] }>;
}) {
  const raw = (await searchParams).number;
  const invoiceNumber = (Array.isArray(raw) ? raw[0] : raw)?.trim().slice(0, 40) ?? '';
  const { identity, token } = await requireSessionWithToken();
  const mayAct = canRecordTrade(identity.role);
  const [history, debtors] = invoiceNumber
    ? await Promise.all([reminderHistory(token, invoiceNumber), reportsDebtors(token, true)])
    : [null, null];
  const owing = debtors?.rows.find((r) => r.invoiceNumber === history?.invoiceNumber);

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">Reminders</p>
          <h1>{history ? history.invoiceNumber : 'Invoice not found'}</h1>
        </div>
        <SignOutButton />
      </header>

      <AppNav active="reminders" held={heldBy(identity)} role={identity.role} />

      {!history ? (
        <div className="rk-card">
          <p className="rk-dash-empty-line">
            {invoiceNumber
              ? `There is no invoice numbered ${invoiceNumber} in your books.`
              : 'Choose an invoice on the reminders page to see its reminders.'}
          </p>
          <p className="rk-fineprint">
            <a href="/app/reminders">Back to reminders</a>
          </p>
        </div>
      ) : (
        <>
          <div className="rk-card">
            <h2>Send a reminder</h2>
            {owing ? (
              <p className={styles.summary}>
                <Money kobo={owing.balanceDueK} /> is still owed on this invoice. A reminder quotes
                the balance Rekoda reads just before sending.
              </p>
            ) : (
              <p className={styles.summary}>
                The balance for this invoice is not shown here. Rekoda reads it just before sending,
                and never reminds a customer about an invoice that is paid.
              </p>
            )}
            {!mayAct ? (
              <p className="rk-fineprint">
                Your access is view only, so you can read these reminders but not send or stop them.
                The owner or a helper can.
              </p>
            ) : history.remindersStopped ? (
              <p className="rk-fineprint">
                Reminders are stopped for this invoice. Resume them below to send one.
              </p>
            ) : (
              <SendReminderForm invoiceNumber={history.invoiceNumber} />
            )}
          </div>

          <div className="rk-card">
            <h2>Reminders for this invoice</h2>
            {history.items.length === 0 ? (
              <p className={`rk-dash-empty-line ${styles.spaced}`}>
                No reminders for this invoice yet.
                {mayAct && !history.remindersStopped ? ' Send one above.' : ''}
              </p>
            ) : (
              <ul className={styles.rows} aria-label="Reminder history">
                {history.items.map((item) => {
                  const { label, tone } = reminderStatusLabel(item.status);
                  const detail = reminderStatusDetail(item.status, item.reasonCode, item.channel);
                  return (
                    <li key={item.id} className={styles.row}>
                      <div className={styles.rowHead}>
                        <span>
                          <strong>{channelName(item.channel)}</strong>,{' '}
                          {lagosDateTime(item.sentAt ?? item.createdAt)}
                        </span>
                        <StatusText label={label} tone={tone} />
                      </div>
                      {item.balanceK !== null && item.status === 'sent' ? (
                        <p className={styles.rowDetail}>
                          Quoted <Money kobo={item.balanceK} /> as owing.
                        </p>
                      ) : null}
                      {detail ? <p className={styles.rowDetail}>{detail}</p> : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {mayAct ? (
            <div className="rk-card">
              <h2>{history.remindersStopped ? 'Reminders are stopped' : 'Stop reminders'}</h2>
              <p className="rk-fineprint">
                {history.remindersStopped
                  ? 'Nothing is sent for this invoice, including reminders already scheduled, until you resume them.'
                  : 'Stopping holds every reminder for this invoice, including ones already scheduled, until you resume them. The invoice and what is owed do not change.'}
              </p>
              <StopRemindersForm
                invoiceNumber={history.invoiceNumber}
                stopped={history.remindersStopped}
              />
            </div>
          ) : null}

          <p className="rk-fineprint">
            <a href="/app/reminders">Back to reminders</a>
          </p>
        </>
      )}
    </section>
  );
}
