import type { Metadata } from 'next';
import { periodBefore, periodLabel, usagePeriod } from '@rekoda/core';
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
  const {
    trialBalance,
    profitAndLoss,
    balanceSheet,
    cashflow,
    comparison,
    expenseSchedule,
    revenueSchedule,
  } = statements;

  /**
   * VAT, read straight off the liability account the posting builder already
   * credits. `chargedK` is this month; `owedK` is everything collected and
   * not yet paid over, which is the balance a merchant is actually holding.
   */
  const vatRow = trialBalance.rows.find((r) => r.account === 'VAT_PAYABLE');
  const vat = {
    /* The trial balance is the PERIOD; the balance sheet carries the running
     * liability, which is the money actually being held. */
    chargedK: Math.max(0, (vatRow?.creditK ?? 0) - (vatRow?.debitK ?? 0)),
    owedK: Math.max(
      0,
      balanceSheet.liabilities.find((l) => l.account === 'VAT_PAYABLE')?.amountK ?? 0,
    ),
  };

  const label = periodLabel(period);
  const priorLabel = periodLabel(comparison.period);
  const previous = periodBefore(period);
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
          {/* VAT first, because it is the figure with a deadline attached.
              Everything else on this page tells a merchant how they are
              doing; this one tells them what they owe somebody else. */}
          {vat.chargedK > 0 || vat.owedK > 0 ? (
            <div className="rk-card rk-dash-card">
              <h2>VAT</h2>
              <p className="rk-dash-total">
                <Money kobo={vat.chargedK} />{' '}
                <span className="rk-fineprint">charged to customers in {label}</span>
              </p>
              <p className="rk-fineprint">
                <Money kobo={vat.owedK} /> is sitting on your books as VAT you have collected and
                not yet paid over. This is what your ledger says, not a return: what you actually
                owe depends on your registration and what you can reclaim, and your accountant
                decides that.
              </p>
            </div>
          ) : null}

          <div className="rk-dash-grid">
            <div className="rk-card rk-dash-card">
              <h2>Profit and loss</h2>
              <p className="rk-fineprint">
                What you earned and spent in {label}, against {priorLabel}.
              </p>
              <div className="rk-table-scroll">
                <table className="rk-statement rk-statement-compare">
                  <thead>
                    <tr>
                      <th />
                      <th>{label}</th>
                      {/* The column every accounting package puts here.
                          "₦150,000 of sales" is a figure; "₦150,000, up from
                          ₦92,000" is what the merchant wanted to know. */}
                      <th>{priorLabel}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="rk-statement-section">
                      <th colSpan={3}>Income</th>
                    </tr>
                    {profitAndLoss.income.map((line) => (
                      <tr key={line.account}>
                        <td>{line.name}</td>
                        <td>
                          <Money kobo={line.amountK} />
                        </td>
                        <td>
                          <Prior kobo={comparison.lines[line.account]} />
                        </td>
                      </tr>
                    ))}
                    <tr className="rk-statement-total">
                      <td>Total income</td>
                      <td>
                        <Money kobo={profitAndLoss.totalIncomeK} />
                      </td>
                      <td>
                        <Money kobo={comparison.totalIncomeK} />
                      </td>
                    </tr>
                    <tr className="rk-statement-section">
                      <th colSpan={3}>Expenses</th>
                    </tr>
                    {profitAndLoss.expenses.map((line) => (
                      <tr key={line.account}>
                        <td>{line.name}</td>
                        <td>
                          <Money kobo={line.amountK} />
                        </td>
                        <td>
                          <Prior kobo={comparison.lines[line.account]} />
                        </td>
                      </tr>
                    ))}
                    <tr className="rk-statement-total">
                      <td>Total expenses</td>
                      <td>
                        <Money kobo={profitAndLoss.totalExpensesK} />
                      </td>
                      <td>
                        <Money kobo={comparison.totalExpensesK} />
                      </td>
                    </tr>
                    <tr className="rk-statement-grand">
                      <td>{profitAndLoss.netProfitK >= 0 ? 'Net profit' : 'Net loss'}</td>
                      <td>
                        <Money kobo={Math.abs(profitAndLoss.netProfitK)} />
                      </td>
                      <td>
                        <Money kobo={Math.abs(comparison.netProfitK)} />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {profitAndLoss.netProfitK !== comparison.netProfitK ? (
                <p className="rk-fineprint">
                  {comparison.netProfitK < 0 && profitAndLoss.netProfitK >= 0
                    ? `You were at a loss in ${priorLabel} and are in profit now.`
                    : profitAndLoss.netProfitK > comparison.netProfitK
                      ? `Up on ${priorLabel}.`
                      : `Down on ${priorLabel}.`}
                </p>
              ) : null}
            </div>

            {/* The other half of the same question. A merchant selling in the
                shop, on Instagram, at the market and over the phone gets one
                "Sales" line, and the one thing they most want from it is
                which of the four is worth the effort. */}
            {revenueSchedule.lines.length > 0 ? (
              <div className="rk-card rk-dash-card">
                <h2>Where the sales came from</h2>
                <p className="rk-fineprint">
                  Sales in {label} by channel. Rekoda records a channel only when you name one, so
                  anything you did not say stays as not recorded.
                </p>
                <table className="rk-statement">
                  <tbody>
                    {revenueSchedule.lines.map((line) => (
                      <tr key={line.source ?? 'unattributed'}>
                        <td>{line.label}</td>
                        <td className="rk-num">
                          <Money kobo={line.amountK} />
                        </td>
                        <td className="rk-num rk-fineprint">
                          {share(line.amountK, revenueSchedule.totalK)}
                        </td>
                      </tr>
                    ))}
                    <tr className="rk-statement-total">
                      <td>Total sales</td>
                      <td className="rk-num">
                        <Money kobo={revenueSchedule.totalK} />
                      </td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : null}

            {/* The working behind one line above, which is the line a merchant
                argues with. "Operating Expenses ₦412,000" invites the
                question; this answers it, biggest first, so the thing eating
                the month is the first thing read. */}
            {expenseSchedule.lines.length > 0 ? (
              <div className="rk-card rk-dash-card">
                <h2>Where the expenses went</h2>
                <p className="rk-fineprint">
                  Operating expenses in {label}, broken down. Stock bought for resale is not here:
                  it reaches the books as cost of goods sold when it sells.
                </p>
                <table className="rk-statement">
                  <tbody>
                    {expenseSchedule.lines.map((line) => (
                      <tr key={line.category}>
                        <td>{line.label}</td>
                        <td className="rk-num">
                          <Money kobo={line.amountK} />
                        </td>
                        {/* Share of the month, because ₦80,000 means nothing
                            without knowing it is a fifth of everything spent. */}
                        <td className="rk-num rk-fineprint">
                          {share(line.amountK, expenseSchedule.totalK)}
                        </td>
                      </tr>
                    ))}
                    <tr className="rk-statement-total">
                      <td>Total operating expenses</td>
                      <td className="rk-num">
                        <Money kobo={expenseSchedule.totalK} />
                      </td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : null}

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

          {/* A screen is not something a merchant can forward. A bank, a
              landlord or a grant officer wants a file with a date on it. */}
          <p className="rk-fineprint">
            <a href={`/app/export/statements?period=${period}`} download>
              Download all four statements for {label} as a PDF
            </a>
            {' · '}
            {/* The PDF is for somebody who will read it. This is for somebody
                who will work with it: four tabs, every figure a real number. */}
            <a href={`/app/export/workbook?period=${period}`} download>
              or as an Excel workbook
            </a>
          </p>
        </>
      )}
    </section>
  );
}

/**
 * A prior-period figure, or a dash when that account had none.
 *
 * A dash and a zero mean different things on a comparison column: zero says
 * they spent nothing on it last month, a dash says the line did not exist.
 */
function Prior({ kobo }: { kobo: number | undefined }) {
  return kobo === undefined ? <span className="rk-fineprint">-</span> : <Money kobo={kobo} />;
}

/**
 * A line's share of the month.
 *
 * "0%" beside ₦2,000 reads as a bug rather than as a small number, so
 * anything that rounds to nothing says so as "under 1%" instead. Nothing at
 * all when there is no total to be a share of.
 */
function share(amountK: number, totalK: number): string | null {
  if (totalK <= 0) return null;
  const percent = Math.round((amountK / totalK) * 100);
  return percent === 0 ? 'under 1%' : `${percent}%`;
}
