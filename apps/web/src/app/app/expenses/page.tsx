import type { Metadata } from 'next';
import { exportCaption } from '@/lib/export-caption';
import {
  EXPENSE_CATEGORY_LABELS,
  formatKobo,
  isExpenseCategory,
  STOCK_CATEGORY,
} from '@rekoda/core';
import { Money } from '@/components/ui/Money';
import { reportsExpenses } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { RegisterPager, pageParam } from '@/components/ui/RegisterPager';
import { AppNav } from '../AppNav';
import { VoidSpendForm, type VoidableEntry } from './VoidSpendForm';
import { canRecordTrade, isOwner } from '@/lib/permissions';
import { PaySupplierForm } from './PaySupplierForm';
import {
  CancelPurchaseOrderForm,
  CreatePurchaseOrderForm,
  ReceivePurchaseOrderForm,
  type OpenPurchaseOrder,
} from './PurchaseOrderForms';
import { DisposeAssetForm, RecordAssetForm, WithdrawAssetForm } from './AssetForms';
import { CreateRecurringForm, StopRecurringForm, type StoppableSchedule } from './RecurringForms';
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
export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const page = pageParam((await searchParams).page);
  const { identity, token } = await requireSessionWithToken();
  const {
    entries,
    count,
    expensesK,
    purchasesK,
    payableK,
    payableAgeing,
    recurring,
    recurringTotal,
    outstanding,
    assets,
    assetsTotal,
    purchaseOrders,
    purchaseOrdersTotal,
  } = await reportsExpenses(token, page);

  /* Only what can still be withdrawn is offered, and each option carries the
   * date and the figure: two "diesel" rows in one week is the normal case,
   * and a list of descriptions alone would be a coin toss. */
  const withdrawable: VoidableEntry[] = entries
    .filter((entry) => entry.status !== 'voided')
    .map((entry) => ({
      id: entry.id,
      label: `${shortDate(entry.recordedAt)} · ${entry.description} · ${formatKobo(entry.amountK)}`,
    }));

  const openPurchaseOrders: OpenPurchaseOrder[] = purchaseOrders
    .filter((po) => po.status === 'open')
    .map((po) => ({
      poNumber: po.poNumber,
      label: `${po.poNumber} · ${formatKobo(po.totalK)}${po.expectedOn ? ` · by ${longDate(po.expectedOn)}` : ''}`,
    }));

  const running = recurring.filter((schedule) => schedule.active);
  const stoppable: StoppableSchedule[] = running.map((schedule) => ({
    id: schedule.id,
    label: `${schedule.description} · ${formatKobo(schedule.amountK)} · ${ordinal(schedule.anchorDay)}`,
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

      {/* Only when there is a debt to age. An ageing table of four zeros
          teaches a merchant to scroll past the thing that will matter most
          the week they owe somebody. */}
      {payableAgeing.totalK > 0 ? (
        <div className="rk-card">
          <h2>How long you have owed it</h2>
          <p className="rk-fineprint">
            By age, not by lateness. A supplier bill has no due date in Rekoda, because Rekoda keeps
            nothing about suppliers, so this counts from the day you bought rather than a deadline
            nobody agreed.
          </p>
          <div className="rk-table-scroll">
            <table className="rk-table">
              <thead>
                <tr>
                  <th className="rk-num">Up to 30 days</th>
                  <th className="rk-num">31 to 60</th>
                  <th className="rk-num">61 to 90</th>
                  <th className="rk-num">Over 90 days</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="rk-num">
                    <Money kobo={payableAgeing.d0_30K} />
                  </td>
                  <td className="rk-num">
                    <Money kobo={payableAgeing.d31_60K} />
                  </td>
                  <td className="rk-num">
                    <Money kobo={payableAgeing.d61_90K} />
                  </td>
                  <td className="rk-num">
                    <Money kobo={payableAgeing.d90PlusK} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {/* Only when there is one. A settlement made by manual journal names
              no purchase, so Rekoda will not claim to know which debt it
              cleared, and will not drop the money either. The sign says which
              direction it went. */}
          {payableAgeing.unlinkedK !== 0 ? (
            <p className="rk-fineprint">
              {payableAgeing.unlinkedK < 0
                ? `A further ${formatKobo(-payableAgeing.unlinkedK)} has been settled by journal entries that do not say which purchase they paid, so it is not taken off any of the four figures above. Recording payments against the purchase itself keeps these buckets true.`
                : `A further ${formatKobo(payableAgeing.unlinkedK)} is owed through journal entries that name no purchase, so there is no date to age it from.`}
            </p>
          ) : null}
          {canRecordTrade(identity.role) ? (
            <>
              <h3>Pay a supplier</h3>
              <p className="rk-fineprint">
                Recorded against the purchase it settles, which is what lets both the figure above
                and your balance sheet move together. Nothing is sent to anybody: this records that
                the money went out. Oldest purchase first.
              </p>
              <PaySupplierForm purchases={outstanding} />
            </>
          ) : null}
        </div>
      ) : null}

      {/* Between the debt and the assets, because that is its lifecycle: an
          open order is stock on the way, and receiving it is what creates the
          purchase and the debt the cards around it describe. */}
      <div className="rk-card">
        <h2>Orders to suppliers</h2>
        <p className="rk-fineprint">
          Write down what you asked a supplier for before it lands. Nothing touches your books until
          you mark it received: then the stock is counted onto your shelf, what you paid leaves
          cash, and the rest joins what you owe suppliers. No supplier name is kept, here or
          anywhere in Rekoda.
        </p>

        {purchaseOrders.length > 0 ? (
          <div className="rk-table-scroll">
            <table className="rk-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Sent</th>
                  <th>Expected</th>
                  <th>Status</th>
                  <th className="rk-num">Items</th>
                  <th className="rk-num">Total</th>
                </tr>
              </thead>
              <tbody>
                {purchaseOrders.map((po) => (
                  <tr key={po.poNumber}>
                    <td>{po.poNumber}</td>
                    <td>{shortDate(po.createdAt)}</td>
                    <td>{po.expectedOn ? longDate(po.expectedOn) : ''}</td>
                    <td>{describePoStatus(po.status)}</td>
                    <td className="rk-num">{po.itemCount}</td>
                    <td className="rk-num">
                      <Money kobo={po.totalK} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rk-fineprint">
            Nothing ordered yet. The first one you save appears here with its own PO number.
          </p>
        )}
        {purchaseOrdersTotal > purchaseOrders.length ? (
          <p className="rk-fineprint">
            Showing {purchaseOrders.length} of {purchaseOrdersTotal}. The newest are here.
          </p>
        ) : null}

        {canRecordTrade(identity.role) ? (
          <>
            <details className="rk-void">
              <summary>Send a new purchase order</summary>
              <CreatePurchaseOrderForm />
            </details>
            <details className="rk-void">
              <summary>The goods landed: mark one received</summary>
              <p className="rk-fineprint">
                This is the moment the money and the stock become real: every line is counted onto
                your shelf at its line cost, and whatever you have not paid joins what you owe
                suppliers above.
              </p>
              <ReceivePurchaseOrderForm orders={openPurchaseOrders} />
            </details>
            {openPurchaseOrders.length > 0 ? (
              <details className="rk-void">
                <summary>Withdraw one</summary>
                <CancelPurchaseOrderForm orders={openPurchaseOrders} />
              </details>
            ) : null}
          </>
        ) : null}
      </div>

      {/* Its own card, and above the schedule, because the decision it asks
          for is the one a merchant gets wrong: a generator is not a running
          cost. Recording it as one reports a loss the business did not make
          and hides a thing it owns (ADR 0026). */}
      <div className="rk-card">
        <h2>Things you bought and keep</h2>
        <p className="rk-fineprint">
          A generator, a freezer, a delivery bike. These are not running costs: you still own them,
          so they sit on your balance sheet and only a slice of the cost is charged against profit
          each month you use them. Recording one as an expense would make this month look far worse
          than it was and every month after look better.
        </p>

        {assetsTotal > 0 ? (
          <div className="rk-table-scroll">
            <table className="rk-table">
              <thead>
                <tr>
                  <th>What it is</th>
                  <th>Bought</th>
                  <th className="rk-num">What it cost</th>
                  <th className="rk-num">Charged so far</th>
                  <th className="rk-num">Still worth</th>
                  <th className="rk-num">Sold for</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((asset) => (
                  <tr key={asset.id}>
                    <td>
                      {asset.description}
                      {asset.status === 'withdrawn' ? (
                        <span className="rk-fineprint"> (taken back out)</span>
                      ) : null}
                      {asset.status === 'sold' ? (
                        <span className="rk-fineprint">
                          {' '}
                          (sold {asset.soldOn ? longDate(asset.soldOn) : ''})
                        </span>
                      ) : null}
                    </td>
                    <td>{longDate(asset.boughtOn)}</td>
                    <td className="rk-num">
                      <Money kobo={asset.costK} />
                    </td>
                    <td className="rk-num">
                      {asset.chargedK === 0 ? 'nothing yet' : <Money kobo={asset.chargedK} />}
                    </td>
                    <td className="rk-num">
                      <Money kobo={asset.bookValueK} />
                    </td>
                    <td className="rk-num">
                      {asset.proceedsK === null ? (
                        ''
                      ) : asset.proceedsK === 0 ? (
                        <span className="rk-fineprint">scrapped</span>
                      ) : (
                        <Money kobo={asset.proceedsK} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {/* The register is what the business has recorded; the table is a
            page of it, still-held things first. Saying so matters more here
            than on a list, because the controls below are built out of the
            same rows: what is not in the table cannot be sold from it. */}
        {assetsTotal > assets.length ? (
          <p className="rk-fineprint">
            Showing {assets.length} of {assetsTotal}. Everything you still hold is here; what is not
            shown has already been sold or taken back out.
          </p>
        ) : null}

        {isOwner(identity.role) ? (
          <details className="rk-void">
            <summary>Record something you bought and keep</summary>
            <RecordAssetForm />
          </details>
        ) : null}

        {/* Not guarded on "is there anything left". The guard used to live here
            and unmounted the whole disclosure the moment the last item was
            sold or withdrawn, taking the confirmation with it: a merchant
            clicked, watched the control vanish, and was told nothing. Each
            form renders its own empty state and keeps its own answer. */}
        {isOwner(identity.role) && assets.length > 0 ? (
          <details className="rk-void">
            <summary>Take one back out</summary>
            <p className="rk-fineprint">
              For when it should never have been recorded: the wrong figure, a duplicate, a thing
              you did not actually buy. Your books go back to exactly where they were, as though you
              had never bought it. If you did buy it and have now sold it, use the control below
              instead: that is a different thing and gives a different answer.
            </p>
            <WithdrawAssetForm assets={assets} />
          </details>
        ) : null}

        {isOwner(identity.role) && assets.length > 0 ? (
          <details className="rk-void">
            <summary>Sell or scrap one</summary>
            <p className="rk-fineprint">
              You bought it, you used it, and now it has gone. Rekoda takes it off your balance
              sheet along with the wear already charged against it, and works out whether you came
              out ahead. That is measured against what it was still worth, not what you paid: the
              months you already charged against profit are not counted twice.
            </p>
            <DisposeAssetForm assets={assets} />
          </details>
        ) : null}
      </div>

      {/* Above the register, because a schedule EXPLAINS rows in it. A merchant
          reading an entry they do not remember dictating needs the answer on
          the way down the page, not below the thing that raised the question. */}
      <div className="rk-card">
        <h2>Costs that repeat</h2>
        <p className="rk-fineprint">
          Rent, salaries, the generator contract. Tell Rekoda once and the entry lands in your books
          on the same day every month, marked Repeating in the register below. Nothing is sent to
          anybody and nothing is paid: this records the cost, exactly as if you had dictated it.
        </p>

        {recurring.length > 0 ? (
          <div className="rk-table-scroll">
            <table className="rk-table">
              <thead>
                <tr>
                  <th>What it is</th>
                  <th>Category</th>
                  <th>Day</th>
                  <th>Paid by</th>
                  <th>Next entry</th>
                  <th>Status</th>
                  <th className="rk-num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {recurring.map((schedule) => (
                  <tr key={schedule.id}>
                    <td>{schedule.description}</td>
                    <td>{describeCategory(schedule.category)}</td>
                    <td>{ordinal(schedule.anchorDay)}</td>
                    <td>{schedule.method === 'transfer' ? 'Transfer' : 'Cash'}</td>
                    {/* A stopped schedule has no next entry, and a date beside
                        the word "Stopped" would be a promise it will not keep. */}
                    <td>{schedule.active ? longDate(schedule.nextDueOn) : 'None'}</td>
                    <td>{schedule.active ? 'Running' : 'Stopped'}</td>
                    <td className="rk-num">
                      <Money kobo={schedule.amountK} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {recurringTotal > recurring.length ? (
          <p className="rk-fineprint">
            Showing {recurring.length} of {recurringTotal}. The newest are here; the rest still
            raise their entries on schedule.
          </p>
        ) : null}

        {isOwner(identity.role) ? (
          <details className="rk-void">
            <summary>Set up a repeating cost</summary>
            <CreateRecurringForm />
          </details>
        ) : null}

        {isOwner(identity.role) && running.length > 0 ? (
          <details className="rk-void">
            <summary>Stop one</summary>
            <p className="rk-fineprint">
              Stopping ends the schedule and nothing else. Every entry it already recorded stays in
              your books, because they were real costs on the days they landed. If one of those was
              wrong, withdraw that entry in the register below.
            </p>
            <StopRecurringForm schedules={stoppable} />
          </details>
        ) : null}
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
                    <th>Source</th>
                    <th>Status</th>
                    <th className="rk-num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id}>
                      <td>{shortDate(entry.recordedAt)}</td>
                      <td>{entry.description}</td>
                      <td>{entry.kind === 'purchase' ? 'Stock purchase' : 'Expense'}</td>
                      <td>{describeCategory(entry.category)}</td>
                      <td>{entry.method === 'transfer' ? 'Transfer' : 'Cash'}</td>
                      <td>{describeSource(entry.sourceType)}</td>
                      <td>{entry.status === 'voided' ? 'Withdrawn' : 'Recorded'}</td>
                      <td className="rk-num">
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
            {isOwner(identity.role) ? (
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
            ) : null}

            <p className="rk-fineprint">
              <a href="/app/export/expenses" download>
                {exportCaption('spending entries', count)}
              </a>
            </p>
            <p className="rk-fineprint">
              {count === 1 ? 'One entry' : `${count} entries`} all time
              {count > entries.length && page === 1
                ? ` · showing the latest ${entries.length}`
                : ''}
            </p>
            <RegisterPager
              page={page}
              count={count}
              pageSize={50}
              basePath="/app/expenses"
              label="entries"
            />
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

/**
 * The category, in the words the statements use.
 *
 * Reading the same label here as on the profit and loss is the point. Until
 * these were a fixed set this column showed whatever the model wrote, so a
 * merchant comparing their register against their own statement was reading
 * "fuel" in one place and "Power and fuel" in the other and had no way to
 * know they were the same money.
 *
 * `stock` is Rekoda's own marker rather than a category, and anything else
 * unrecognised is a row written before the set existed.
 */
function describeCategory(category: string | null): string {
  if (category === null) return 'Uncategorised';
  if (category === STOCK_CATEGORY) return 'Stock';
  return isExpenseCategory(category) ? EXPENSE_CATEGORY_LABELS[category] : category;
}

/**
 * Where the entry came from, in the merchant's terms.
 *
 * Unrecognised source types fall through to "Recorded" rather than showing a
 * system word. A merchant should never have to read `paystack_webhook` off
 * their own spend register to know what happened.
 */
function describeSource(sourceType: string): string {
  if (sourceType === 'recurring') return 'Repeating';
  if (sourceType === 'chat') return 'WhatsApp';
  if (sourceType === 'dashboard') return 'Dashboard';
  if (sourceType === 'purchase_order') return 'Purchase order';
  return 'Recorded';
}

/**
 * A purchase order's status, in the merchant's words. `cancelled` reads as
 * Withdrawn for the same reason a quote's does: the merchant did it, it was
 * not done to them.
 */
function describePoStatus(status: string): string {
  if (status === 'open') return 'Open';
  if (status === 'received') return 'Received';
  if (status === 'cancelled') return 'Withdrawn';
  return status;
}

/** `1st`, `2nd`, `31st`. The day a merchant would say out loud. */
function ordinal(day: number): string {
  if (day >= 11 && day <= 13) return `${day}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] ?? 'th';
  return `${day}${suffix}`;
}

/** `1 Sep 2026`, from a plain calendar day rather than an instant. */
function longDate(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Africa/Lagos',
  });
}

/** `12 Aug`, Lagos time, same as everywhere else on the dashboard. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Africa/Lagos',
  });
}
