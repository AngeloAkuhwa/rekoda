import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { BillingPaymentRecord } from '@rekoda/contracts';
import { Money } from '@/components/ui/Money';
import { heldBy } from '@/lib/capabilities';
import { PLAN_NAMES } from '@/lib/plans';
import { PAYMENT_RECORD_NOTICE, paymentRecordView } from '@/lib/payment-record-copy';
import { billingPayment } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { AppNav } from '../../../AppNav';
import { SignOutButton } from '../../../SignOutButton';
import { PrintButton } from './PrintButton';

export const metadata: Metadata = {
  title: 'Payment record',
  robots: { index: false, follow: false },
};

const KIND_LABELS: Record<BillingPaymentRecord['kind'], string> = {
  first_purchase: 'Subscription',
  renewal: 'Renewal',
  upgrade: 'Plan upgrade',
  add_on: 'Usage pack',
  seat: 'Extra seat',
};

/** Lagos, so a merchant reads the date and time they would write on a form. */
function lagosDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Africa/Lagos',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function lagosDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    timeZone: 'Africa/Lagos',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function whatWasBought(record: BillingPaymentRecord): string {
  if (record.kind === 'add_on') {
    return `${record.packLabel ?? 'Usage pack'}${record.quantity > 1 ? ` × ${record.quantity}` : ''}`;
  }
  const plan = record.plan ? (PLAN_NAMES[record.plan] ?? record.plan) : null;
  const term = record.interval === 'annual' ? 'a year' : 'a month';
  return `${KIND_LABELS[record.kind]}${plan ? ` · ${plan}` : ''} (${term} of service)`;
}

/**
 * `/app/billing/payments/<reference>`: one payment to Rekoda in full (billing Slice A). The reference
 * must be the signed-in business's own; anyone else's answers "not found". Everything shown is read
 * from Rekoda's record of the payment, and the record can be printed or saved as a PDF.
 */
export default async function PaymentRecordPage({
  params,
}: {
  params: Promise<{ reference: string }>;
}) {
  const { reference } = await params;
  const { identity, token } = await requireSessionWithToken('/app/billing');
  const record = await billingPayment(token, decodeURIComponent(reference));
  if (!record) notFound();

  const view = paymentRecordView(record);
  const paidStates = view.confirmed;

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head rk-no-print">
        <div>
          <p className="rk-eyebrow">Billing</p>
          <h1>Payment record</h1>
        </div>
        <SignOutButton />
      </header>
      <div className="rk-no-print">
        <AppNav active="billing" held={heldBy(identity)} role={identity.role} />
      </div>

      <article className="rk-card rk-record" data-state={record.state}>
        <p className="rk-eyebrow rk-print-only">Rekoda · Payment record</p>
        <h2>{view.title}</h2>
        <p>{view.summary}</p>

        <dl className="rk-record-grid">
          <div>
            <dt>What was bought</dt>
            <dd>{whatWasBought(record)}</dd>
          </div>
          <div>
            <dt>Reference</dt>
            <dd className="rk-mono">{record.reference}</dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd>
              <Money kobo={record.amountK} currency={record.currency} />
            </dd>
          </div>
          {paidStates && record.paidAmountK !== null && record.paidAmountK !== record.amountK ? (
            <div>
              <dt>Amount Paystack received</dt>
              <dd>
                <Money kobo={record.paidAmountK} currency={record.currency} />
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Payment status</dt>
            <dd>{paidStates ? 'Confirmed by Paystack' : 'Not confirmed'}</dd>
          </div>
          {record.paidAt ? (
            <div>
              <dt>Paid on</dt>
              <dd>{lagosDateTime(record.paidAt)} (Lagos time)</dd>
            </div>
          ) : null}
          {record.failedAt && record.state === 'failed' ? (
            <div>
              <dt>Reported failed on</dt>
              <dd>{lagosDateTime(record.failedAt)} (Lagos time)</dd>
            </div>
          ) : null}
          {record.refundedAmountK > 0 ? (
            <div>
              <dt>Returned to you</dt>
              <dd>
                <Money kobo={record.refundedAmountK} currency={record.currency} />
                {record.refundedAt ? ` on ${lagosDate(record.refundedAt)}` : ''}
              </dd>
            </div>
          ) : null}
          {record.kind !== 'add_on' && record.periodStart && record.periodEnd ? (
            <div>
              <dt>Service period</dt>
              <dd>
                {lagosDate(record.periodStart)} to {lagosDate(record.periodEnd)}
              </dd>
            </div>
          ) : null}
          {record.kind === 'add_on' ? (
            <div>
              <dt>Valid for</dt>
              <dd>The month it was bought in. Packs do not carry over.</dd>
            </div>
          ) : null}
          <div>
            <dt>Applied to your account</dt>
            <dd>{record.applied ? 'Yes' : 'No'}</dd>
          </div>
          <div>
            <dt>Started on</dt>
            <dd>{lagosDateTime(record.createdAt)} (Lagos time)</dd>
          </div>
        </dl>

        <p className="rk-fineprint">{PAYMENT_RECORD_NOTICE}</p>

        <p className="rk-no-print rk-record-actions">
          <PrintButton />{' '}
          <Link className="rk-btn rk-btn-quiet" href="/app/billing">
            Back to billing
          </Link>
        </p>
      </article>
    </section>
  );
}
