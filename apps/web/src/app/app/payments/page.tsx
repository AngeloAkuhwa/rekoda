import type { Metadata } from 'next';
import { MoneyBadge } from '@/components/ui/MoneyBadge';
import { Money } from '@/components/ui/Money';
import { bankName } from '@/lib/banks';
import { paymentConnection, paymentExceptions, paymentsList } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { AppNav } from '../AppNav';
import { ConnectForm } from './ConnectForm';
import { markExceptionReviewed } from './actions';

export const metadata: Metadata = {
  title: 'Payments',
  robots: { index: false, follow: false },
};

/**
 * The Payments page (docs/payments-v1.md §35): "Payments", never "Paystack" —
 * the provider is plumbing, and the day a second one exists this page does
 * not change its name.
 *
 * Three honest surfaces: where the money settles (masked, always), what has
 * been confirmed, and what needs a human. Nothing here is a number Rekoda
 * did not verify; recorded-but-unverified money lives in the books, not in
 * this list, because this page's entire promise is "these ones are real".
 */
export default async function PaymentsPage() {
  const { token } = await requireSessionWithToken();
  const [connection, payments, exceptions] = await Promise.all([
    paymentConnection(token),
    paymentsList(token),
    paymentExceptions(token),
  ]);

  const bank = bankName(connection.bankCode);
  const open = exceptions.exceptions.filter((e) => e.resolvedAt === null);
  const reviewed = exceptions.exceptions.filter((e) => e.resolvedAt !== null);

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">Payments</p>
          <h1>Where your money lands</h1>
        </div>
      </header>

      <AppNav active="payments" />

      {/* ── the settlement connection (§3–5) ── */}
      {connection.status === 'active' ? (
        <div className="rk-card rk-connection">
          <h2>Settling to your bank</h2>
          <p className="rk-connection-account">
            {bank ?? 'Your bank'} •••• {connection.accountLast4}
          </p>
          <p className="rk-fineprint">
            {connection.accountName}. Customers pay, Paystack settles straight to this account, and
            Rekoda never holds the money.
          </p>
        </div>
      ) : connection.status === 'not_configured' ? (
        <div className="rk-card rk-connection">
          <h2>Get paid straight to your bank</h2>
          <p>
            Add your settlement account once. Every payment link Rekoda creates will settle there,
            verified, with the receipt and the books handled for you.
          </p>
          <ConnectForm />
        </div>
      ) : connection.status === 'failed' ? (
        <div className="rk-card rk-connection">
          <h2>That account did not verify</h2>
          <p>
            Your payment provider could not confirm the account details. Check the number and bank,
            then submit them again.
          </p>
          <ConnectForm />
        </div>
      ) : (
        <div className="rk-card rk-connection">
          <h2>Your account is being set up</h2>
          <p className="rk-connection-account">
            {bank ?? 'Your bank'} •••• {connection.accountLast4}
          </p>
          <p className="rk-fineprint">
            Details saved. Activation finishes as soon as payment collection goes live, and you will
            not need to enter anything again.
          </p>
        </div>
      )}

      {/* ── verified payments (§16–17) ── */}
      <div className="rk-card">
        <h2>Verified payments</h2>
        {payments.payments.length === 0 ? (
          <p className="rk-fineprint">
            None yet. When a customer pays through a Rekoda payment link, the verified payment
            appears here with its reference, fee and settlement.
          </p>
        ) : (
          <div className="rk-table-scroll">
            <table className="rk-table">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Received</th>
                  <th>Fee</th>
                  <th>Settled</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {payments.payments.map((p, i) => (
                  <tr key={p.rekodaReference ?? i}>
                    <td>{p.rekodaReference ?? '(recorded)'}</td>
                    <td>
                      {p.grossAmountK == null ? 'not shown' : <Money kobo={p.grossAmountK} />}
                    </td>
                    <td>{p.providerFeeK == null ? 'none' : <Money kobo={p.providerFeeK} />}</td>
                    <td>
                      {p.settlementAmountK == null ? (
                        'pending'
                      ) : (
                        <Money kobo={p.settlementAmountK} />
                      )}
                    </td>
                    <td>
                      <MoneyBadge state={p.verified === 1 ? 'verified' : 'recorded'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── the exception queue (§35): the money that needs a human ── */}
      <div className="rk-card">
        <h2>Needs your attention</h2>
        {open.length === 0 ? (
          <p className="rk-fineprint">Nothing. Every verified payment matched what was expected.</p>
        ) : (
          <ul className="rk-exception-list">
            {open.map((e) => (
              <li key={e.id}>
                <MoneyBadge state="attention">{describeException(e.reason)}</MoneyBadge>
                <span className="rk-fineprint">
                  {e.amountK == null ? null : <Money kobo={e.amountK} />}
                  {e.outstandingK != null && e.outstandingK < 0 ? (
                    <>
                      {' '}
                      (overpaid by <Money kobo={-e.outstandingK} />)
                    </>
                  ) : null}
                  {' · '}
                  {exceptionDate(e.createdAt)}
                </span>
                <form action={markExceptionReviewed}>
                  <input type="hidden" name="exceptionId" value={e.id} />
                  <button type="submit" className="rk-review-btn">
                    Mark reviewed
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
        {reviewed.length > 0 ? (
          <p className="rk-fineprint">
            {reviewed.length === 1
              ? 'One item already reviewed.'
              : `${reviewed.length} items already reviewed.`}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** `12 Aug` beside each item, so age is visible at a glance. */
function exceptionDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Africa/Lagos',
  });
}

/** Exception reasons, said the way a merchant would say them. */
function describeException(reason: string | null): string {
  switch (reason) {
    case 'overpaid':
      return 'A customer paid more than the invoice';
    case 'duplicate':
      return 'Money arrived for an invoice already settled';
    case 'late_confirmation':
      return 'A payment confirmed after its link expired';
    case 'currency_mismatch':
      return 'A payment arrived in the wrong currency';
    case 'verify_not_found':
      return 'A payment alert the provider could not confirm';
    default:
      return 'A payment that needs review';
  }
}
