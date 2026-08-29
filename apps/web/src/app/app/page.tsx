import type { Metadata } from 'next';
import { allowanceFor, USAGE_UNITS, type UsageUnit } from '@rekoda/core';
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
import { PLAN_NAMES } from '@/lib/plans';
import { CashflowChart } from './CashflowChart';
import { SignOutButton } from './SignOutButton';
import { heldBy } from '@/lib/capabilities';

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

  /**
   * Every unit this plan actually sells, not just messages.
   *
   * A unit with a zero allowance is not part of this plan (voice on
   * Integrate, orders on Chat) and showing an empty bar for it would read as
   * something broken rather than something not bought.
   */
  const meters = USAGE_UNITS.map((unit) => {
    const row = usage.units.find((u) => u.unit === unit);
    return {
      unit,
      used: row?.used ?? 0,
      allowance: allowanceFor(usage.plan, unit) + (row?.bonus ?? 0),
    };
  }).filter((m) => m.allowance > 0);

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">{PLAN_NAMES[identity.plan] ?? identity.plan}</p>
          <h1>{identity.businessName}</h1>
          <p className="rk-fineprint">
            Signed in as {identity.phone} · {identity.role} · {monthName}
          </p>
        </div>
        <SignOutButton />
      </header>

      <AppNav active="overview" held={heldBy(identity)} />

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
          <h2>How old the debt is</h2>
          {overview.ageing.totalK > 0 ? (
            <>
              <p className="rk-dash-total">
                <Money kobo={overview.ageing.overdueK} />{' '}
                <span className="rk-fineprint">past the day it was promised</span>
              </p>
              {/* The ageing columns an accountant reads first, and the ones
                  both QuickBooks and HelloBooks put on the front page. */}
              <div className="rk-table-scroll">
                <table className="rk-table">
                  <thead>
                    <tr>
                      <th className="rk-num">Not due yet</th>
                      <th className="rk-num">1 to 30 days</th>
                      <th className="rk-num">31 to 60</th>
                      <th className="rk-num">61 to 90</th>
                      <th className="rk-num">Over 90</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="rk-num">
                        <Money kobo={overview.ageing.currentK} />
                      </td>
                      <td className="rk-num">
                        <Money kobo={overview.ageing.d1_30K} />
                      </td>
                      <td className="rk-num">
                        <Money kobo={overview.ageing.d31_60K} />
                      </td>
                      <td className="rk-num">
                        <Money kobo={overview.ageing.d61_90K} />
                      </td>
                      <td className="rk-num">
                        <Money kobo={overview.ageing.d90PlusK} />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="rk-fineprint">
                Money with no agreed date counts as not due yet. Tell Rekoda when you sell, like
                &quot;she will pay on Friday&quot;, and it lands in the right column.
              </p>
            </>
          ) : (
            <p className="rk-dash-empty-line">
              Nothing outstanding. Every invoice you have issued is fully paid.
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
                      <span className="rk-fineprint"> · {dueLabel(row)}</span>
                    </span>
                    <Money kobo={row.balanceDueK} />
                  </li>
                ))}
              </ul>
              {debtors.count > debtors.rows.length ? (
                <p className="rk-fineprint">
                  And {debtors.count - debtors.rows.length} more.{' '}
                  <a href="/app/debtors">See everyone who owes you</a>, or ask on WhatsApp: *who
                  owes me*
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
          {meters.map((meter) => (
            <div key={meter.unit} className="rk-meter-row">
              <p className="rk-fineprint">
                {meter.used} of {meter.allowance} {UNIT_LABELS[meter.unit]} used
              </p>
              <div
                className="rk-meter"
                role="meter"
                aria-valuemin={0}
                aria-valuemax={meter.allowance}
                aria-valuenow={meter.used}
                aria-label={`${UNIT_LABELS[meter.unit]} used this month`}
              >
                <span
                  className="rk-meter-fill"
                  style={{
                    width: `${Math.min(100, Math.round((meter.used / Math.max(1, meter.allowance)) * 100))}%`,
                  }}
                />
              </div>
            </div>
          ))}
          <p className="rk-fineprint">
            Free commands like *who owes me* and *payment details* never count. Need more? Reply{' '}
            *upgrade* on WhatsApp and we will set you up, or <a href="/pricing">see plans</a>.
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
 * What a merchant needs to know about one debt, in the space of a few words.
 *
 * How late it is, when there is an agreed day and it has passed; when it is
 * due, when that day is still ahead; and the issue date when nobody agreed
 * anything, because that is all we honestly know.
 */
function dueLabel(row: { issuedAt: string; dueDate: string | null; daysOverdue: number }): string {
  if (row.daysOverdue > 0) {
    return row.daysOverdue === 1 ? 'one day late' : `${row.daysOverdue} days late`;
  }
  if (row.dueDate) return `due ${issuedLabel(row.dueDate)}`;
  return `issued ${issuedLabel(row.issuedAt)}`;
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

/** The units, in merchant words. Same vocabulary as the WhatsApp reply. */
const UNIT_LABELS: Record<UsageUnit, string> = {
  AI_ACTIONS: 'messages',
  VOICE_MINUTES: 'seconds of voice notes',
  DOCUMENT_GENERATION: 'invoices and receipts',
  DOCUMENTS_UNDERSTOOD: 'document scans',
  SERVICE_MESSAGE: 'replies inside the 24-hour window',
  UTILITY_TEMPLATE: 'order and payment updates',
  AUTH_TEMPLATE: 'login codes',
  AUTH_INTL_TEMPLATE: 'international login codes',
  MARKETING_TEMPLATE: 'marketing messages',
  CATALOGUE_ORDERS: 'orders',
  PAYMENT_CONNECTIONS: 'payment connections',
  FINANCIAL_ACCOUNT_CONNECTIONS: 'bank connections',
  ACCOUNTANT_USERS: 'accountant logins',
  REPORT_EXPORTS: 'report downloads',
  API_REQUEST_UNITS: 'API requests',
  API_APPLICATIONS: 'API applications',
  WEBHOOK_DELIVERIES: 'webhook deliveries',
};
