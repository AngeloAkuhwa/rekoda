import type { Metadata } from 'next';
import { Money } from '@/components/ui/Money';
import { reportsAudit } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { AppNav } from '../AppNav';
import { exportCaption } from '@/lib/export-caption';
import { SignOutButton } from '../SignOutButton';

export const metadata: Metadata = {
  title: 'Audit trail',
  robots: { index: false, follow: false },
};

/**
 * The audit trail (MASTER-PLAN §42).
 *
 * QuickBooks calls this the Audit Log and it is what an accountant or a tax
 * officer asks for by name. It is deliberately NOT the overview's activity
 * strip: that answers "what happened to my money", and this answers "who
 * changed something, and why". A shop with an accountant and a delegate needs
 * the second question answered as much as the first.
 *
 * Rekoda has been keeping this record since M1 and had never shown it to the
 * merchant it is kept for.
 */
export default async function AuditPage() {
  const { token } = await requireSessionWithToken();
  const { events, count } = await reportsAudit(token);

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">Audit trail</p>
          <h1>Who changed what</h1>
        </div>
        <SignOutButton />
      </header>

      <AppNav active="audit" />

      <div className="rk-card">
        <h2>Every recorded change</h2>
        <p className="rk-fineprint">
          This is the record an accountant or a tax officer asks for. Nothing here can be edited or
          removed, by you or by Rekoda: entries are only ever added.
        </p>

        {events.length === 0 ? (
          <p className="rk-fineprint">
            Nothing recorded yet. The first invoice you raise in chat appears here with the time it
            happened and who did it.
          </p>
        ) : (
          <>
            <div className="rk-table-scroll">
              <table className="rk-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>What happened</th>
                    <th>Who</th>
                    <th>Where</th>
                    <th>Why</th>
                    <th className="rk-num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.id}>
                      <td>{stamp(event.at)}</td>
                      <td>{event.summary}</td>
                      <td>{presentActor(event.actor)}</td>
                      <td>{sourceWord(event.source)}</td>
                      {/* Blank rather than "none": most actions do not require
                          a reason, and only the ones that do look bare. */}
                      <td>{event.reason ?? ''}</td>
                      <td className="rk-num">
                        {event.amountK === null ? '' : <Money kobo={event.amountK} />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="rk-fineprint">
              <a href="/app/export/audit" download>
                {exportCaption('changes', count)}
              </a>
            </p>
            <p className="rk-fineprint">
              {count === 1 ? 'One change' : `${count} changes`} all time
              {count > events.length ? ` · showing the latest ${events.length}` : ''}
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/** Where the change came from, in the words a merchant would use. */
/**
 * The API resolves actors to "Owner 1234"; a member since removed comes back
 * as the raw `user:<uuid>`, which is a support handle, not a name to print.
 */
function presentActor(actor: string): string {
  if (actor.startsWith('user:')) return `Former member (${actor.slice(5, 13)})`;
  return actor;
}

function sourceWord(source: string): string {
  if (source === 'chat') return 'WhatsApp';
  if (source === 'dashboard') return 'Dashboard';
  if (source === 'operator') return 'Rekoda support';
  if (source === 'system') return 'Automatic';
  if (source.startsWith('webhook')) return 'Payment provider';
  return source;
}

/**
 * `12 Aug, 14:05` in Lagos time. The trail is the one page where the CLOCK
 * time matters as much as the date: "who did this, and when" is the question,
 * and two changes on the same day are the case it has to separate.
 */
function stamp(iso: string): string {
  return new Date(iso).toLocaleString('en-NG', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Africa/Lagos',
  });
}
