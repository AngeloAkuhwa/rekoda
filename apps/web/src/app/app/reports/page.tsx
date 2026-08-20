import type { Metadata } from 'next';
import { usagePeriod } from '@rekoda/core';
import { Money } from '@/components/ui/Money';
import { requireSessionWithToken } from '@/server/guards';
import { reportsStatements } from '@/server/api';
import { AppNav } from '../AppNav';
import { SignOutButton } from '../SignOutButton';

export const metadata: Metadata = {
  title: 'Reports',
  robots: { index: false, follow: false },
};

/**
 * The four statements (ADR 0015): trial balance, profit and loss, balance
 * sheet, cash flow. Structure an accountant expects, labels a merchant can
 * read. Every figure arrives computed from the ledger and contract-parsed;
 * this page holds no arithmetic beyond none.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string | string[] }>;
}) {
  const { identity, token } = await requireSessionWithToken();

  const raw = (await searchParams).period;
  const requested = typeof raw === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) ? raw : null;
  const current = usagePeriod(new Date());
  const period = requested ?? current;

  const statements = await reportsStatements(token, period);
  const { trialBalance, profitAndLoss, balanceSheet, cashflow } = statements;

  const label = periodLabel(period);
  const previous = previousPeriod(period);
  const empty = trialBalance.rows.length === 0;

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">Reports</p>
          <h1>{identity.businessName}</h1>
          <p className="rk-fineprint">Your books for {label}, straight from the ledger.</p>
        </div>
        <SignOutButton />
      </header>

      <AppNav active="reports" />

      <div className="rk-period-row">
        <a
          href={`/app/reports?period=${previous}`}
          className="rk-period-link"
          aria-label={`View ${periodLabel(previous)}`}
        >
          ← {periodLabel(previous)}
        </a>
        <span className="rk-period-current">{label}</span>
        {period !== current ? (
          <a href="/app/reports" className="rk-period-link">
            This month →
          </a>
        ) : (
          <span className="rk-period-link rk-period-now">Current month</span>
        )}
      </div>

      {empty ? (
        <div className="rk-card rk-dash-empty">
          <h2>No entries for {label}</h2>
          <p>
            Statements build themselves from what you record on WhatsApp. Once a sale, expense or
            payment lands in this month, all four reports fill in here.
          </p>
        </div>
      ) : (
        <>
          <div className="rk-dash-grid">
            <div className="rk-card rk-dash-card">
              <h2>Profit and loss</h2>
              <p className="rk-fineprint">What you earned and spent in {label}.</p>
              <table className="rk-statement">
                <tbody>
                  <tr className="rk-statement-section">
                    <th colSpan={2}>Income</th>
                  </tr>
                  {profitAndLoss.income.map((line) => (
                    <tr key={line.account}>
                      <td>{line.name}</td>
                      <td>
                        <Money kobo={line.amountK} />
                      </td>
                    </tr>
                  ))}
                  <tr className="rk-statement-total">
                    <td>Total income</td>
                    <td>
                      <Money kobo={profitAndLoss.totalIncomeK} />
                    </td>
                  </tr>
                  <tr className="rk-statement-section">
                    <th colSpan={2}>Expenses</th>
                  </tr>
                  {profitAndLoss.expenses.map((line) => (
                    <tr key={line.account}>
                      <td>{line.name}</td>
                      <td>
                        <Money kobo={line.amountK} />
                      </td>
                    </tr>
                  ))}
                  <tr className="rk-statement-total">
                    <td>Total expenses</td>
                    <td>
                      <Money kobo={profitAndLoss.totalExpensesK} />
                    </td>
                  </tr>
                  <tr className="rk-statement-grand">
                    <td>{profitAndLoss.netProfitK >= 0 ? 'Net profit' : 'Net loss'}</td>
                    <td>
                      <Money kobo={Math.abs(profitAndLoss.netProfitK)} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="rk-card rk-dash-card">
              <h2>Cash flow</h2>
              <p className="rk-fineprint">Money that actually moved in {label}.</p>
              <table className="rk-statement">
                <tbody>
                  <tr>
                    <td>Opening balance</td>
                    <td>
                      <Money kobo={cashflow.openingK} />
                    </td>
                  </tr>
                  <tr>
                    <td>Money in</td>
                    <td>
                      <Money kobo={cashflow.inK} />
                    </td>
                  </tr>
                  <tr>
                    <td>Money out</td>
                    <td>
                      <Money kobo={cashflow.outK} />
                    </td>
                  </tr>
                  <tr className="rk-statement-grand">
                    <td>Closing balance</td>
                    <td>
                      <Money kobo={cashflow.closingK} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="rk-dash-grid">
            <div className="rk-card rk-dash-card">
              <h2>Balance sheet</h2>
              <p className="rk-fineprint">What the business owns and owes, as at end of {label}.</p>
              <table className="rk-statement">
                <tbody>
                  <tr className="rk-statement-section">
                    <th colSpan={2}>Assets</th>
                  </tr>
                  {balanceSheet.assets.map((line) => (
                    <tr key={line.account}>
                      <td>{line.name}</td>
                      <td>
                        <Money kobo={line.amountK} />
                      </td>
                    </tr>
                  ))}
                  <tr className="rk-statement-total">
                    <td>Total assets</td>
                    <td>
                      <Money kobo={balanceSheet.totalAssetsK} />
                    </td>
                  </tr>
                  <tr className="rk-statement-section">
                    <th colSpan={2}>Liabilities</th>
                  </tr>
                  {balanceSheet.liabilities.map((line) => (
                    <tr key={line.account}>
                      <td>{line.name}</td>
                      <td>
                        <Money kobo={line.amountK} />
                      </td>
                    </tr>
                  ))}
                  <tr className="rk-statement-total">
                    <td>Total liabilities</td>
                    <td>
                      <Money kobo={balanceSheet.totalLiabilitiesK} />
                    </td>
                  </tr>
                  <tr className="rk-statement-section">
                    <th colSpan={2}>Equity</th>
                  </tr>
                  {balanceSheet.equity.map((line) => (
                    <tr key={`${line.account}-${line.name}`}>
                      <td>{line.name}</td>
                      <td>
                        <Money kobo={line.amountK} />
                      </td>
                    </tr>
                  ))}
                  <tr className="rk-statement-grand">
                    <td>Liabilities + equity</td>
                    <td>
                      <Money kobo={balanceSheet.totalLiabilitiesK + balanceSheet.totalEquityK} />
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className={balanceSheet.balanced ? 'rk-balanced' : 'rk-unbalanced'}>
                {balanceSheet.balanced
                  ? 'Assets equal liabilities plus equity.'
                  : 'These books do not balance. Contact support and do not rely on this page.'}
              </p>
            </div>

            <div className="rk-card rk-dash-card">
              <h2>Trial balance</h2>
              <p className="rk-fineprint">Every account, as at end of {label}.</p>
              <div className="rk-table-scroll">
                <table className="rk-statement rk-tbal">
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Debit</th>
                      <th>Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trialBalance.rows.map((row) => (
                      <tr key={row.account}>
                        <td>
                          <span className="rk-fineprint">{row.code}</span> {row.name}
                        </td>
                        <td>{row.debitK > 0 ? <Money kobo={row.debitK} /> : null}</td>
                        <td>{row.creditK > 0 ? <Money kobo={row.creditK} /> : null}</td>
                      </tr>
                    ))}
                    <tr className="rk-statement-grand">
                      <td>Totals</td>
                      <td>
                        <Money kobo={trialBalance.totalDebitK} />
                      </td>
                      <td>
                        <Money kobo={trialBalance.totalCreditK} />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className={trialBalance.balanced ? 'rk-balanced' : 'rk-unbalanced'}>
                {trialBalance.balanced
                  ? 'Debits equal credits. The books balance.'
                  : 'Debits do not equal credits. Contact support and do not rely on this page.'}
              </p>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function periodLabel(period: string): string {
  return new Date(`${period}-01T00:00:00Z`).toLocaleDateString('en-NG', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function previousPeriod(period: string): string {
  const [year, month] = period.split('-').map(Number);
  const d = new Date(Date.UTC(year!, month! - 2, 1));
  return d.toISOString().slice(0, 7);
}
