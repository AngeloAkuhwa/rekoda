import type { Metadata } from 'next';
import Link from 'next/link';
import { referenceFromQuery, returnView } from '@/lib/billing-return';
import { heldBy } from '@/lib/capabilities';
import { billingOverview } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { AppNav } from '../../AppNav';
import { SignOutButton } from '../../SignOutButton';
import { ReturnPoller } from './ReturnPoller';

export const metadata: Metadata = {
  title: 'Payment status',
  robots: { index: false, follow: false },
};

/**
 * `/app/billing/return`, where Paystack sends the merchant after the hosted payment page. It
 * reads the payment's reference from the address and the OUTCOME from Rekoda's own records, so
 * the merchant sees "paid" only once a verified payment has been applied.
 */
export default async function BillingReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ reference?: string | string[]; trxref?: string | string[] }>;
}) {
  const query = await searchParams;
  const reference = referenceFromQuery(query);
  const { identity, token } = await requireSessionWithToken('/app/billing');
  const overview = await billingOverview(token);
  const view = returnView(overview, reference);

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">Billing</p>
          <h1>Payment status</h1>
        </div>
        <SignOutButton />
      </header>
      <AppNav active="billing" held={heldBy(identity)} role={identity.role} />
      <div className="rk-card" data-return={view.kind}>
        <h2>{view.title}</h2>
        <p>{view.body}</p>
        {view.poll ? <ReturnPoller /> : null}
        <p>
          <Link className="rk-btn" href="/app/billing">
            Back to billing
          </Link>
        </p>
      </div>
    </section>
  );
}
