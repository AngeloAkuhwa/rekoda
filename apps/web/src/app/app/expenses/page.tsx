import type { Metadata } from 'next';
import { formatKobo } from '@rekoda/core';
import { Money } from '@/components/ui/Money';
import { reportsExpenses } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { AppNav } from '../AppNav';
import { VoidSpendForm, type VoidableEntry } from './VoidSpendForm';
import { SignOutButton } from '../SignOutButton';

export const metadata: Metadata = {
  title: 'Expenses',
  robots: { index: false, follow: false },
};

/**
 * The spend register (MASTER-PLAN §5.3.7).
 *
 * The other half of the books. Sales and receipts have had a page each since
 * M2; this is where the money went, and without it a merchant can see what
 * they earned and not what it cost them.
 *
 * Expenses and stock purchases are totalled separately and never added. An
 * expense is spent and a purchase is still on the shelf, and one combined
 * figure would overstate the cost of trading by the value of the inventory.
 */
export default async function ExpensesPage() {
  const { token } = await requireSessionWithToken();
  const { entries, count, expensesK, purchasesK, payableK } = await reportsExpenses(token);

  /* Only what can still be withdrawn is offered, and each option carries the
   * date and the figure: two "diesel" rows in one week is the normal case,
   * and a list of descriptions alone would be a coin toss. */
  const withdrawable: VoidableEntry[] = entries
    .filter((entry) => entry.status !== 'voided')
    .map((entry) => ({
      id: entry.id,
      label: `${shortDate(entry.recordedAt)} · ${entry.description} · ${formatKobo(entry.amountK)}`,
    }));

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">Expenses</p>
          <h1>Where the money went</h1>
        </div>
        <SignOutButton />
      </header>

      <AppNav active="expenses" />

      <div className="rk-stat-grid">
        <SpendStat
          label="Operating expenses"
          valueK={expensesK}
          hint="All time. This is the figure your profit and loss subtracts."
        />
        <SpendStat
          label="Stock purchases"
          valueK={purchasesK}
          hint="All time. Stock is not a cost until it sells, so it sits apart."
        />
        <SpendStat
          label="Owed to suppliers"
          valueK={payableK}
          hint="Accounts payable: stock taken that has not been fully paid for."
        />
      </div>

      <div className="rk-card">
        <h2>Spend register</h2>
        {entries.length === 0 ? (
          <p className="rk-fineprint">
            Nothing recorded yet. Tell Rekoda on WhatsApp what you spent, confirm the preview, and
            it lands here and in your books at the same moment.
          </p>
        ) : (
          <>
            <div className="rk-table-scroll">
              <table className="rk-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description</th>
                    <th>Type</th>
                    <th>Category</th>
                    <th>Paid by</th>
                    <th>Status</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id}>
                      <td>{shortDate(entry.recordedAt)}</td>
                      <td>{entry.description}</td>
                      <td>{entry.kind === 'purchase' ? 'Stock purchase' : 'Expense'}</td>
                      <td>{entry.category ?? 'Uncategorised'}</td>
                      <td>{entry.method === 'transfer' ? 'Transfer' : 'Cash'}</td>
                      <td>{entry.status === 'voided' ? 'Withdrawn' : 'Recorded'}</td>
                      <td>
                        <Money kobo={entry.amountK} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* An accounting tool a merchant cannot correct is one they stop
                trusting. Nothing is deleted: the entry stays, marked, and the
                books carry it alongside its reversal. */}
            <details className="rk-void">
              <summary>Withdraw an entry</summary>
              <p className="rk-fineprint">
                Use this when something was recorded that should not have been: the wrong figure,
                the same receipt twice, a purchase that fell through. The entry stays in your
                records marked as withdrawn, and your books show it beside the reversal that
                cancelled it. Nothing is deleted, and your stock count is left alone.
              </p>
              <VoidSpendForm entries={withdrawable} />
            </details>

            <p className="rk-fineprint">
              <a href="/app/export/expenses" download>
                Download all spending as a spreadsheet (CSV)
              </a>
            </p>
            <p className="rk-fineprint">
              {count === 1 ? 'One entry' : `${count} entries`} all time
              {count > entries.length ? ` · showing the latest ${entries.length}` : ''}
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * A ledger cell. Zero keeps its own muted style rather than borrowing the
 * typography of a confirmed figure, same rule as the overview's tiles.
 */
function SpendStat({ label, valueK, hint }: { label: string; valueK: number; hint: string }) {
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
      <p className="rk-fineprint">{hint}</p>
    </div>
  );
}

/** `12 Aug`, Lagos time, same as everywhere else on the dashboard. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Africa/Lagos',
  });
}
