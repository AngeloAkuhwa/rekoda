import type { Metadata } from 'next';
import { allowanceFor } from '@rekoda/core';
import { Money } from '@/components/ui/Money';
import { MoneyBadge } from '@/components/ui/MoneyBadge';
import { requireSessionWithToken } from '@/server/guards';
import {
  reportsActivity,
  reportsCashflow,
  reportsDebtors,
  reportsOverview,
  usageMeter,
} from '@/server/api';
import { AppNav } from './AppNav';
import { CashflowChart } from './CashflowChart';
import { SignOutButton } from './SignOutButton';

export const metadata: Metadata = {
  title: 'Your dashboard',
  robots: { index: false, follow: false },
};

/**
 * The dashboard: the "books you can show" surface (MASTER-PLAN §5.3.7).
 *
 * Rekoda is used on WhatsApp; this page is where the merchant LOOKS — and
 * where they hand the phone to an accountant or a loan officer. Every figure
 * on it was computed by SQL in the API tier from the double-entry ledger and
 * parsed against a contract at the boundary. Nothing here does arithmetic,
 * and nothing here ever will.
 *
 * Empty states stay words, not zeros: "₦0" is a computed claim worth making
 * only once there is a ledger to compute it from, and a brand-new business
 * deserves an explanation, not a wall of noughts.
 */
export default async function DashboardPage() {
  const { identity, token } = await requireSessionWithToken();

  const [overview, cashflow, debtors, activity, usage] = await Promise.all([
    reportsOverview(token),
    reportsCashflow(token),
    reportsDebtors(token),
    reportsActivity(token),
    usageMeter(token),
  ]);

  const hasBooks = activity.items.length > 0;
  const hasCashflow = cashflow.months.some((m) => m.inK > 0 || m.outK > 0);
  const monthName = new Date(`${overview.period}-01T00:00:00Z`).toLocaleDateString('en-NG', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  const messagesUsed = usage.units.find((u) => u.unit === 'messages');
  const messagesAllowance = allowanceFor(usage.plan, 'messages') + (messagesUsed?.bonus ?? 0);

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">{identity.plan === 'trial' ? 'Free trial' : identity.plan}</p>
          <h1>{identity.businessName}</h1>
          <p className="rk-fineprint">
            Signed in as {identity.phone} · {identity.role} · {monthName}
          </p>
        </div>
        <SignOutButton />
      </header>

      <AppNav active="overview" />

      {overview.exceptionsOpen > 0 ? (
        <a href="/app/payments" className="rk-attention-strip">
          {overview.exceptionsOpen === 1
            ? 'One payment needs your attention.'
            : `${overview.exceptionsOpen} payments need your attention.`}{' '}
          See what happened.
        </a>
      ) : null}

      <div className="rk-stat-grid">
        <StatTile
          label="Money in"
          hint={`Cash that arrived in ${monthName}`}
          valueK={overview.moneyInK}
        >
          {overview.verifiedInK > 0 ? (
            <span className="rk-stat-badge">
              <MoneyBadge state="verified" /> <Money kobo={overview.verifiedInK} /> confirmed
            </span>
          ) : null}
        </StatTile>
        <StatTile
          label="Money out"
          hint="Expenses and stock you have recorded"
          valueK={overview.moneyOutK}
        />
        <StatTile label="Owed to you" hint="Invoices still unpaid" valueK={overview.owedToYouK} />
        {overview.youOweK > 0 ? (
          <StatTile
            label="You owe suppliers"
            hint="Stock taken on credit"
            valueK={overview.youOweK}
          />
        ) : null}
      </div>

      <div className="rk-dash-grid">
        <div className="rk-card rk-dash-card">
          <h2>Cash flow</h2>
          {hasCashflow ? (
            <CashflowChart months={cashflow.months} />
          ) : (
            <p className="rk-dash-empty-line">
              Nothing has moved yet. The first sale or expense you record on WhatsApp draws the
              first bar here.
            </p>
          )}
        </div>

        <div className="rk-card rk-dash-card">
          <h2>Who owes you</h2>
          {debtors.count > 0 ? (
            <>
              <p className="rk-dash-total">
                <Money kobo={debtors.totalK} />{' '}
                <span className="rk-fineprint">
                  across {debtors.count === 1 ? 'one invoice' : `${debtors.count} invoices`}
                </span>
              </p>
              <ul className="rk-debtor-list">
                {debtors.rows.map((row) => (
                  <li key={row.invoiceNumber}>
                    <span>
                      {row.invoiceNumber}
                      <span className="rk-fineprint"> · {issuedLabel(row.issuedAt)}</span>
                    </span>
                    <Money kobo={row.balanceDueK} />
                  </li>
                ))}
              </ul>
              {debtors.count > debtors.rows.length ? (
                <p className="rk-fineprint">
                  And {debtors.count - debtors.rows.length} more. Ask on WhatsApp: *who owes me*
                </p>
              ) : null}
            </>
          ) : (
            <p className="rk-dash-empty-line">
              Nobody. Every invoice you have issued is fully paid, or you have not issued one yet.
            </p>
          )}
        </div>
      </div>

      <div className="rk-dash-grid">
        <div className="rk-card rk-dash-card">
          <h2>Recent activity</h2>
          {hasBooks ? (
            <ul className="rk-activity-list">
              {activity.items.map((item, i) => (
                <li key={`${item.at}-${i}`}>
                  <span>
                    {item.label}
                    <span className="rk-fineprint"> · {issuedLabel(item.at)}</span>
                  </span>
                  <Money kobo={item.amountK} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="rk-dash-empty-line">
              Rekoda builds your records from what you tell it on WhatsApp. Send your first sale and
              it appears here, with the working shown so you can check every figure.
            </p>
          )}
        </div>

        <div className="rk-card rk-dash-card">
          <h2>Your plan this month</h2>
          <p className="rk-dash-total">
            {messagesUsed?.used ?? 0}
            <span className="rk-fineprint"> of {messagesAllowance} messages used</span>
          </p>
          <div
            className="rk-meter"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={messagesAllowance}
            aria-valuenow={messagesUsed?.used ?? 0}
            aria-label="Messages used this month"
          >
            <span
              className="rk-meter-fill"
              style={{
                width: `${Math.min(100, Math.round(((messagesUsed?.used ?? 0) / Math.max(1, messagesAllowance)) * 100))}%`,
              }}
            />
          </div>
          <p className="rk-fineprint">
            Free commands like *who owes me* and *payment details* never count. Need more?{' '}
            <a href="/pricing">See plans</a>.
          </p>
        </div>
      </div>
    </section>
  );
}

/** `12 Aug` — short enough for a list row, unambiguous in en-NG. */
function issuedLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Africa/Lagos',
  });
}

/**
 * A money tile: a real ₦ figure once one exists, and words before then.
 * The three money states (spec §7) still hold — a figure here is CONFIRMED
 * by the ledger, and "none yet" is unknown, so it never borrows the
 * typography of a computed number.
 */
function StatTile({
  label,
  hint,
  valueK,
  children,
}: {
  label: string;
  hint: string;
  valueK: number;
  children?: React.ReactNode;
}) {
  return (
    <div className="rk-stat">
      <p className="rk-stat-label">{label}</p>
      {valueK > 0 ? (
        <p className="rk-stat-value">
          <Money kobo={valueK} />
        </p>
      ) : (
        <p className="rk-stat-empty" aria-label={`${label}: nothing recorded yet`}>
          none yet
        </p>
      )}
      {children}
      <p className="rk-fineprint">{hint}</p>
    </div>
  );
}
