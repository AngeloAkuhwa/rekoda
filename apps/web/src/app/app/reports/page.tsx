import type { Metadata } from 'next';
import { lagosDay, periodBefore, periodLabel, usagePeriod } from '@rekoda/core';
import { Money } from '@/components/ui/Money';
import { requireSessionWithToken } from '@/server/guards';
import { reportsStatements } from '@/server/api';
import { AppNav } from '../AppNav';
import { OpeningForm } from './OpeningForm';
import { canRecordTrade, isOwner } from '@/lib/permissions';
import { StockCountForm } from './StockCountForm';
import { CloseBooksForm } from './CloseBooksForm';
import { JournalForm } from './JournalForm';
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
  /* The ceiling on the opening date. Lagos, not the browser's zone: a
   * merchant in Lagos at 00:30 must not be told their own today is tomorrow. */
  const today = lagosDay(new Date());

  const statements = await reportsStatements(token, period);
  const {
    trialBalance,
    profitAndLoss,
    balanceSheet,
    cashflow,
    comparison,
    expenseSchedule,
    revenueSchedule,
    openingBalances,
    stockValuation,
    booksClosedThrough,
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
  /* Closed through August means August and everything before it. A watermark
   * comparison rather than equality, or July would read as open. */
  const periodClosed = booksClosedThrough !== null && period <= booksClosedThrough;
  /* Only a month that has ENDED can be closed, which is also why the guard can
   * never catch an ordinary posting: those are stamped now. */
  const closable = period < current;

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
        <span className="rk-period-current">
          {label}
          {periodClosed ? <span className="rk-closed-chip">Closed</span> : null}
        </span>
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
          {/* The one control that belongs on an empty page, because the
              merchant who needs it most is the one who has recorded nothing
              yet. It lives inside the balance sheet the rest of the time,
              beside the figure it fixes, and that card is not rendered here
              at all: without this, a business could not open its books until
              after it had already posted something to them. */}
          {openingBalances === null ? (
            isOwner(identity.role) ? (
              <details className="rk-void">
                <summary>Open your books with what you already had</summary>
                <p className="rk-fineprint">
                  Rekoda only knows what you have told it since you joined. If you already had cash,
                  money in the bank or stock on the shelf, say so once and your balance sheet starts
                  from the truth instead of from zero.
                </p>
                <OpeningForm today={today} />
              </details>
            ) : null
          ) : null}
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
                    {/* Gross profit, printed only when there is a cost of
                        sales to take off. Revenue less nothing is revenue,
                        and a "gross profit" line equal to the sales line
                        dresses up "we were never told what it cost" as a
                        margin. */}
                    {profitAndLoss.costOfSalesK !== 0 ? (
                      <>
                        <tr>
                          <td>Cost of goods sold</td>
                          <td className="rk-num">
                            <Money kobo={profitAndLoss.costOfSalesK} />
                          </td>
                          <td />
                        </tr>
                        <tr className="rk-statement-total">
                          <td>Gross profit</td>
                          <td className="rk-num">
                            <Money kobo={profitAndLoss.grossProfitK} />
                          </td>
                          <td />
                        </tr>
                      </>
                    ) : null}
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
                      <td>
                        {profitAndLoss.costOfSalesK !== 0
                          ? 'Total running costs'
                          : 'Total expenses'}
                      </td>
                      <td>
                        <Money
                          kobo={
                            profitAndLoss.costOfSalesK !== 0
                              ? profitAndLoss.operatingExpensesK
                              : profitAndLoss.totalExpensesK
                          }
                        />
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
                <div className="rk-table-scroll">
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
                <div className="rk-table-scroll">
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
              </div>
            ) : null}

            <div className="rk-card rk-dash-card">
              <h2>Cash flow</h2>
              <p className="rk-fineprint">Money that actually moved in {label}.</p>
              <div className="rk-table-scroll">
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
          </div>

          <div className="rk-dash-grid">
            <div className="rk-card rk-dash-card">
              <h2>Balance sheet</h2>
              <p className="rk-fineprint">What the business owns and owes, as at end of {label}.</p>
              <div className="rk-table-scroll">
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
              </div>
              <p className={balanceSheet.balanced ? 'rk-balanced' : 'rk-unbalanced'}>
                {balanceSheet.balanced
                  ? 'Assets equal liabilities plus equity.'
                  : 'These books do not balance. Contact support and do not rely on this page.'}
              </p>
              {/* A negative asset is not a small presentational problem: a till
                  cannot hold less than nothing, so the figure is telling the
                  merchant something is missing rather than telling them a
                  balance. Said plainly, with the likeliest cause named. */}
              {balanceSheet.assets.some((line) => line.amountK < 0) ? (
                <p className="rk-fineprint">
                  One of these balances is below zero, which cannot be true of a real till or a real
                  account. It means Rekoda has recorded more going out than it knows came in.{' '}
                  {openingBalances
                    ? 'Something you sold or were paid is probably not recorded yet.'
                    : 'Most often that is money you already had before you joined.'}
                </p>
              ) : null}
              {/* The control sits under the figure it fixes. A merchant who
                  joined with money in the till and spent from it is reading a
                  NEGATIVE cash balance a few lines above this, and telling
                  them about opening balances anywhere else on the site would
                  be telling them somewhere they are not looking. */}
              {openingBalances ? (
                <p className="rk-fineprint">
                  Your books open on {shortDate(openingBalances.asAt)} with{' '}
                  <Money kobo={openingBalances.cashK + openingBalances.bankK} /> in money and{' '}
                  <Money kobo={openingBalances.stockK} /> of stock.
                </p>
              ) : isOwner(identity.role) ? (
                <details className="rk-void">
                  <summary>Open your books with what you already had</summary>
                  <p className="rk-fineprint">
                    Rekoda only knows what you have told it since you joined. If you already had
                    cash, money in the bank or stock on the shelf, say so once and your balance
                    sheet starts from the truth instead of from zero.
                  </p>
                  <OpeningForm today={today} />
                </details>
              ) : null}
              {/* Stock is the one asset on this sheet that can be counted, and
                  the only one that drifts in a direction nothing corrects. A
                  purchase dictated as prose debits stock against no product,
                  so nothing ever credits it back when those goods sell. Both
                  figures are shown rather than one reconciled: writing the
                  ledger down quietly would destroy the evidence that anything
                  was ever wrong.

                  The current month only, and not as a courtesy. A count is a
                  fact about TODAY, while the sheet above it is as at the end
                  of whichever month is being read. Beside a past month the
                  two Inventory figures would differ for a reason no merchant
                  could see, which is the exact confusion this exists to end. */}
              {period === current &&
              (stockValuation.ledgerK !== 0 || stockValuation.countedK !== 0) ? (
                <div className="rk-stocktake">
                  <h3 className="rk-substack">Stock on the shelf</h3>
                  <div className="rk-table-scroll">
                    <table className="rk-statement">
                      <tbody>
                        <tr>
                          <td>What your books say</td>
                          <td>
                            <Money kobo={stockValuation.ledgerK} />
                          </td>
                        </tr>
                        <tr>
                          <td>What you are holding, at cost</td>
                          <td>
                            <Money kobo={stockValuation.countedK} />
                          </td>
                        </tr>
                        <tr className="rk-statement-total">
                          <td>Difference</td>
                          <td>
                            <Money kobo={stockValuation.differenceK} />
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  {stockValuation.uncosted > 0 ? (
                    <p className="rk-fineprint">
                      {stockValuation.uncosted === 1
                        ? 'One product is on your shelf with no cost recorded, so the count above leaves it out.'
                        : `${stockValuation.uncosted} products are on your shelf with no cost recorded, so the count above leaves them out.`}{' '}
                      <a href="/app/catalogue">
                        {stockValuation.uncosted === 1
                          ? 'Set what it costs you'
                          : 'Set what they cost you'}
                      </a>{' '}
                      and this will settle.
                    </p>
                  ) : stockValuation.differenceK === 0 ? (
                    <p className="rk-fineprint">Your books and your shelf agree.</p>
                  ) : (
                    <>
                      <p className="rk-fineprint">
                        {stockValuation.differenceK < 0
                          ? 'Your books claim stock you are not holding. Most often that is stock bought as a lump sum, which goes onto the shelf as money but never comes off as goods sold.'
                          : 'You are holding more stock than your books account for. Most often that is stock that arrived without a purchase being recorded.'}
                      </p>
                      {canRecordTrade(identity.role) ? (
                        <StockCountForm short={stockValuation.differenceK < 0} />
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
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

          {/* Folded away, like voiding an invoice, and for the same reason: a
              control that writes straight to the ledger should not sit open
              beside four statements inviting the tap it exists to prevent.
              Only on the current month, because a correction dated into a
              past month is the rarer case and the date field covers it
              without putting the form on every page a merchant browses. */}
          {isOwner(identity.role) && period === current ? (
            <details className="rk-void rk-journal">
              <summary>Move money, or fix an entry that went to the wrong place</summary>
              <p className="rk-fineprint">
                For the things that are not a sale, a payment or a cost: cash you carried to the
                bank, money you put in yourself, an amount that landed in the wrong place. Most
                merchants never need this.
              </p>
              <JournalForm today={today} />
            </details>
          ) : null}

          {/* Closing sits beside the download, because the download is what it
              protects. A statement forwarded to a bank should still say the
              same thing next month, and until a month is closed nothing
              promises that: a backdated expense, a caught-up recurring entry
              or a late opening balance would all change it silently. */}
          {closable ? (
            <div className="rk-card rk-dash-card rk-closebooks">
              <h2>{periodClosed ? `${label} is closed` : `Closing ${label}`}</h2>
              <p className="rk-fineprint">
                {periodClosed
                  ? 'Nothing new can be dated into this month, so the statements above will still say this next year. Reopen it if you have a correction to make.'
                  : 'Once you have sent these statements to anybody, close the month. Nothing dated in it can be recorded afterwards, so the copy they hold and the copy here cannot drift apart.'}
              </p>
              {isOwner(identity.role) ? (
                <CloseBooksForm period={period} label={label} closed={periodClosed} />
              ) : null}
            </div>
          ) : null}

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

/** `31 Jul 2026`. Longer than the register's `31 Jul` on purpose: opening
 * balances are read once, months later, and the year is the part that
 * matters. */
function shortDate(day: string): string {
  return new Date(`${day}T12:00:00+01:00`).toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Africa/Lagos',
  });
}
