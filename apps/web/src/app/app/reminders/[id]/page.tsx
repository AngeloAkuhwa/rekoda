import type { Metadata } from 'next';
import { reminderBatch } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { heldBy } from '@/lib/capabilities';
import { canRecordTrade } from '@/lib/permissions';
import {
  BATCH_DUE_NOTE,
  batchItemStatus,
  batchStateLabel,
  channelName,
  channelsLabel,
  invoicesCount,
  lagosDateTime,
  reminderStatusDetail,
  reminderStatusLabel,
} from '@/lib/reminder-copy';
import { AppNav } from '../../AppNav';
import { SignOutButton } from '../../SignOutButton';
import { StatusText } from '../StatusText';
import { CancelBatchForm } from './CancelBatchForm';
import { ReleaseHeldBatchKeys } from './ReleaseHeldBatchKeys';
import styles from '../reminders.module.css';

export const metadata: Metadata = {
  title: 'Reminder batch',
  robots: { index: false, follow: false },
};

/**
 * One batch and every recipient's state (REM-06). The counts are the API's SQL counts and each
 * recipient's line is its reminder rows once a send was attempted, so the page shows what the
 * books show and never infers delivery.
 */
export default async function ReminderBatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ new?: string | string[] }>;
}) {
  const { id } = await params;
  /* Reached from a Confirm redirect, not by opening a batch from the list. */
  const landedFromConfirm = (await searchParams).new === '1';
  const { identity, token } = await requireSessionWithToken();
  const batch = await reminderBatch(token, id);
  const now = new Date();

  return (
    <section className="rk-container rk-dash">
      {batch && landedFromConfirm ? <ReleaseHeldBatchKeys /> : null}
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">Reminders</p>
          <h1>
            {batch
              ? `${invoicesCount(batch.itemCount)}, ${batchStateLabel(batch.state, batch.scheduledFor, now).toLowerCase()}`
              : 'Batch not found'}
          </h1>
        </div>
        <SignOutButton />
      </header>

      <AppNav active="reminders" held={heldBy(identity)} role={identity.role} />

      {!batch ? (
        <div className="rk-card">
          <p className="rk-dash-empty-line">
            There is no reminder batch here for this business. It may belong to another business, or
            the link is incomplete.
          </p>
          <p className="rk-fineprint">
            <a href="/app/reminders">Back to reminders</a>
          </p>
        </div>
      ) : (
        <>
          <div className="rk-card">
            <h2>{batchStateLabel(batch.state, batch.scheduledFor, now)}</h2>
            <p className={styles.summary}>
              {channelsLabel(batch.channels)}.{' '}
              {batch.state === 'cancelled' && batch.cancelledAt
                ? `Cancelled on ${lagosDateTime(batch.cancelledAt)}.`
                : batch.state === 'completed' && batch.completedAt
                  ? `Finished on ${lagosDateTime(batch.completedAt)}.`
                  : new Date(batch.scheduledFor).getTime() > now.getTime()
                    ? `Sends on ${lagosDateTime(batch.scheduledFor)}.`
                    : BATCH_DUE_NOTE}
            </p>
            <dl className={styles.counts}>
              <div>
                <dt>Sent</dt>
                <dd>{batch.counts.sent}</dd>
              </div>
              <div>
                <dt>Not sent</dt>
                <dd>{batch.counts.notSent}</dd>
              </div>
              <div>
                <dt>Could not be confirmed</dt>
                <dd>{batch.counts.uncertain}</dd>
              </div>
              <div>
                <dt>Waiting</dt>
                <dd>{batch.counts.pending}</dd>
              </div>
              <div>
                <dt>Cancelled</dt>
                <dd>{batch.counts.cancelled}</dd>
              </div>
            </dl>
            <p className="rk-fineprint">
              Confirmed on {lagosDateTime(batch.createdAt)}. This page shows the state when it
              opened; <a href={`/app/reminders/${batch.id}`}>refresh it</a> to see the latest.
            </p>
            {canRecordTrade(identity.role) ? (
              <CancelBatchForm
                batchId={batch.id}
                pending={batch.counts.pending}
                cancellable={batch.state === 'scheduled' && batch.counts.pending > 0}
              />
            ) : null}
          </div>

          <div className="rk-card">
            <h2>Each invoice</h2>
            <ul className={styles.rows} aria-label="Recipients">
              {batch.items.map((item) => {
                const status = batchItemStatus(item);
                return (
                  <li key={item.invoiceNumber} className={styles.row}>
                    <div className={styles.rowHead}>
                      <a
                        className={styles.rowTitle}
                        href={`/app/reminders/invoice?number=${encodeURIComponent(item.invoiceNumber)}`}
                      >
                        {item.invoiceNumber}
                      </a>
                      <StatusText label={status.label} tone={status.tone} />
                    </div>
                    {item.reminders.length > 0 ? (
                      item.reminders.map((r) => {
                        const line = reminderStatusLabel(r.status);
                        const detail = reminderStatusDetail(r.status, r.reasonCode, r.channel);
                        return (
                          <p key={r.channel} className={styles.channelLine}>
                            <strong>{channelName(r.channel)}:</strong> {line.label.toLowerCase()}
                            {r.sentAt ? ` on ${lagosDateTime(r.sentAt)}` : ''}.
                            {detail ? ` ${detail}` : ''}
                          </p>
                        );
                      })
                    ) : status.detail ? (
                      <p className={styles.rowDetail}>{status.detail}</p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <p className="rk-fineprint">
              <a href="/app/reminders">Back to reminders</a>
            </p>
          </div>
        </>
      )}
    </section>
  );
}
