import type { Metadata } from 'next';
import { exportCaption } from '@/lib/export-caption';
import { Money } from '@/components/ui/Money';
import { MoneyBadge } from '@/components/ui/MoneyBadge';
import { reportsReceipts } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { RegisterPager, pageParam } from '@/components/ui/RegisterPager';
import { AppNav } from '../AppNav';
import { SignOutButton } from '../SignOutButton';
import { heldBy } from '@/lib/capabilities';

export const metadata: Metadata = {
  title: 'Receipts',
  robots: { index: false, follow: false },
};

/**
 * The receipt register (MASTER-PLAN §5.3.7). A receipt exists here only
 * because a real payment was recorded against it — there is no path that
 * mints one otherwise (spec rule 12), which is what makes this page worth
 * showing a tax officer.
 */
export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const page = pageParam((await searchParams).page);
  const { identity, token } = await requireSessionWithToken();
  const { receipts, count } = await reportsReceipts(token, page);

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">Receipts</p>
          <h1>Proof of every payment</h1>
        </div>
        <SignOutButton />
      </header>

      <AppNav active="receipts" held={heldBy(identity)} role={identity.role} />

      <div className="rk-card">
        <h2>Receipt register</h2>
        <p className="rk-fineprint">
          A receipt acknowledges that one payment was accepted, with what was known the moment it
          was issued. It never changes afterwards. Where a customer&apos;s whole account stands
          lives on their statement, reached from the <a href="/app/invoices">invoices page</a>.
        </p>
        {receipts.length === 0 ? (
          <p className="rk-fineprint">
            No receipts yet. When a payment settles an invoice, the receipt is issued and numbered
            here automatically.
          </p>
        ) : (
          <>
            <div className="rk-table-scroll">
              <table className="rk-table">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Date</th>
                    <th className="rk-num">Amount</th>
                    <th>Invoice</th>
                    <th>Basis</th>
                  </tr>
                </thead>
                <tbody>
                  {receipts.map((receipt) => (
                    <tr key={receipt.receiptNumber}>
                      <td>{receipt.receiptNumber}</td>
                      <td>{shortDate(receipt.issuedAt)}</td>
                      <td className="rk-num">
                        <Money kobo={receipt.amountK} />
                      </td>
                      <td>{receipt.invoiceNumber ?? '(no invoice)'}</td>
                      {/* ADR 0014 on the register too. A receipt for cash at
                          the counter and one a provider confirmed are both
                          real, and a merchant answering a query needs to know
                          which of the two they are looking at. */}
                      <td>
                        <MoneyBadge state={receipt.verified === 1 ? 'verified' : 'recorded'} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* The answer to "what happens to my records if I leave". A
                product that cannot be left has to be trusted blindly, and
                asking for that is worse than earning it. */}
            <p className="rk-fineprint">
              <a href="/app/export/receipts" download>
                {exportCaption('receipts', count)}
              </a>
            </p>
            <p className="rk-fineprint">
              {count === 1 ? 'One receipt' : `${count} receipts`} all time
              {count > receipts.length && page === 1
                ? ` · showing the latest ${receipts.length}`
                : ''}
            </p>
            <RegisterPager
              page={page}
              count={count}
              pageSize={50}
              basePath="/app/receipts"
              label="receipts"
            />
          </>
        )}
      </div>
    </section>
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
