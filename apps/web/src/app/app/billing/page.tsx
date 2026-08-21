import type { Metadata } from 'next';
import { Money } from '@/components/ui/Money';
import { PLANS } from '@/lib/plans';
import { billingOverview, billingQuote } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { AppNav } from '../AppNav';
import { SignOutButton } from '../SignOutButton';
import { buyPack, confirmPlanChange } from './actions';

export const metadata: Metadata = {
  title: 'Billing',
  robots: { index: false, follow: false },
};

const UNIT_LABELS: Record<string, string> = {
  messages: 'messages',
  voice_seconds: 'voice seconds',
  documents: 'documents',
  documents_understood: 'documents read',
  orders: 'orders',
};

const PLAN_NAMES: Record<string, string> = {
  trial: 'Free trial',
  expired: 'Stopped',
  chat: 'Rekoda Chat',
  integrate: 'Rekoda Integrate',
  complete: 'Rekoda Complete',
};

const CHARGE_LABELS: Record<string, string> = {
  first_purchase: 'Subscription',
  renewal: 'Renewal',
  upgrade: 'Plan upgrade',
  add_on: 'Add-on pack',
  seat: 'Extra seat',
};

/** Lagos, so a merchant reads the date they would write on a form. */
function lagosDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    timeZone: 'Africa/Lagos',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

const PROBLEMS: Record<string, string> = {
  awaiting_platform_confirmation:
    'Card payments are not switched on yet. Nothing was charged. Message *upgrade* on WhatsApp and we will move you across by hand.',
  not_available_on_plan: 'That pack is not part of your plan. Nothing was charged.',
  unknown_pack: 'That pack does not exist. Nothing was charged.',
  no_cycle: 'That change did not go through. Nothing was charged.',
  plan: 'That change did not go through. Nothing was charged.',
  pack: 'That purchase did not go through. Nothing was charged.',
};

/**
 * Billing (ADR 0024).
 *
 * The page a merchant opens when they want to know what they are paying,
 * what they have used, and what it would cost to change. Every figure comes
 * from the API, which got it from `@rekoda/core/billing`: nothing on this
 * page does money arithmetic, including the proration a merchant is about to
 * be charged.
 *
 * Standard accounting-software shape and deliberately so: current plan, the
 * meter, what a change costs BEFORE it is made, and a billing history that
 * reads like a statement. A merchant who cannot see what they were charged
 * last month is a merchant who cannot reconcile their own expenses.
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ to?: string; done?: string; problem?: string; pay?: string }>;
}) {
  const { token } = await requireSessionWithToken();
  const params = await searchParams;
  const overview = await billingOverview(token);
  const proposed =
    params.to && params.to !== overview.plan ? await billingQuote(token, params.to) : null;

  const meters = overview.units.filter((unit) => unit.allowance + unit.bonus > 0);
  const switchable = PLANS.filter((plan) => plan.id !== overview.plan);

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">Billing</p>
          <h1>Your plan and what it costs</h1>
        </div>
        <SignOutButton />
      </header>

      <AppNav active="billing" />

      {overview.status.state === 'grace' ? (
        <div className="rk-attention-strip" role="status">
          A payment did not go through. Everything keeps working until{' '}
          {lagosDate(overview.status.endsAt)}
          {overview.status.daysLeft === 1
            ? ', one day from now.'
            : `, ${overview.status.daysLeft} days from now.`}{' '}
          Message *upgrade* on WhatsApp and we will sort it out with you.
        </div>
      ) : null}

      {overview.status.state === 'expired' ? (
        <div className="rk-attention-strip" role="status">
          Your subscription stopped on {lagosDate(overview.status.since)}. Your books are still here
          and you can still read and export everything. Message *upgrade* on WhatsApp to start
          again.
        </div>
      ) : null}

      {params.problem ? (
        <div className="rk-attention-strip" role="status">
          {PROBLEMS[params.problem] ?? 'That did not go through. Nothing was charged.'}
        </div>
      ) : null}

      {params.done === 'scheduled' ? (
        <div className="rk-attention-strip" role="status">
          Saved. Your new plan starts at your next renewal, and nothing changes before then.
        </div>
      ) : null}

      {params.pay ? (
        <div className="rk-attention-strip" role="status">
          Reference {params.pay}. Keep this number: it is how we match your payment.
        </div>
      ) : null}

      {/* ── what they are on ── */}
      <div className="rk-card">
        <h2>Current plan</h2>
        <p className="rk-plan-current">
          {PLAN_NAMES[overview.plan] ?? overview.plan}
          {overview.priceK > 0 ? (
            <>
              {' '}
              · <Money kobo={overview.priceK} /> a month
            </>
          ) : null}
        </p>
        <p className="rk-fineprint">
          {overview.status.state === 'active'
            ? `Renews on ${lagosDate(overview.status.renewsAt)}.`
            : overview.status.state === 'trial'
              ? overview.status.endsAt
                ? `Your free trial runs until ${lagosDate(overview.status.endsAt)}. No card needed.`
                : 'Your free trial is running. No card needed.'
              : overview.status.state === 'grace'
                ? `Grace period ends ${lagosDate(overview.status.endsAt)}.`
                : `Stopped ${lagosDate(overview.status.since)}.`}
        </p>
        {overview.pendingPlan ? (
          <p className="rk-fineprint">
            Changing to {PLAN_NAMES[overview.pendingPlan] ?? overview.pendingPlan} at your next
            renewal. You keep what you paid for until then.
          </p>
        ) : null}
      </div>

      {/* ── the meter ── */}
      <div className="rk-card">
        <h2>This month</h2>
        {meters.length === 0 ? (
          <p className="rk-fineprint">
            This plan includes nothing to meter right now. Nothing you do will be refused.
          </p>
        ) : (
          meters.map((meter) => {
            const ceiling = meter.allowance + meter.bonus;
            return (
              <div key={meter.unit} className="rk-meter-row">
                <p>
                  {meter.used} of {ceiling} {UNIT_LABELS[meter.unit] ?? meter.unit} used
                  {meter.bonus > 0 ? ` (${meter.bonus} bought)` : ''}
                </p>
                <div
                  className="rk-meter"
                  role="meter"
                  aria-valuemin={0}
                  aria-valuemax={ceiling}
                  aria-valuenow={meter.used}
                  aria-label={`${UNIT_LABELS[meter.unit] ?? meter.unit} used this month`}
                >
                  <span
                    className="rk-meter-fill"
                    style={{
                      width: `${Math.min(100, Math.round((meter.used / Math.max(1, ceiling)) * 100))}%`,
                    }}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ── changing plan, with the figure shown first ── */}
      {proposed ? (
        <div className="rk-card">
          <h2>Moving to {PLAN_NAMES[proposed.to] ?? proposed.to}</h2>
          {proposed.kind === 'downgrade' ? (
            <p>
              Nothing to pay today. You keep {PLAN_NAMES[proposed.from] ?? proposed.from} until{' '}
              {lagosDate(proposed.renewsAt)}, and the new plan starts then.
            </p>
          ) : proposed.amountK === 0 ? (
            <p>Nothing to pay today. Your renewal date does not change.</p>
          ) : (
            <p>
              <Money kobo={proposed.amountK} /> today
              {proposed.kind === 'upgrade'
                ? `, for the rest of this month. Your renewal stays on ${lagosDate(proposed.renewsAt)}.`
                : `. Renews ${lagosDate(proposed.renewsAt)}.`}
            </p>
          )}
          <form action={confirmPlanChange}>
            <input type="hidden" name="plan" value={proposed.to} />
            <button type="submit" className="rk-btn">
              {proposed.amountK === 0 ? 'Confirm the change' : 'Confirm and pay'}
            </button>{' '}
            <a href="/app/billing" className="rk-period-link">
              Not now
            </a>
          </form>
        </div>
      ) : (
        <div className="rk-card">
          <h2>Change plan</h2>
          <div className="rk-table-scroll">
            <table className="rk-table">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>What it is for</th>
                  <th>A month</th>
                  <th>
                    <span className="rk-sr-only">Choose</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {switchable.map((plan) => (
                  <tr key={plan.id}>
                    <td>{plan.name}</td>
                    <td>{plan.tagline}</td>
                    <td>
                      <Money kobo={plan.monthlyK} />
                    </td>
                    <td>
                      <a href={`/app/billing?to=${plan.id}`} className="rk-period-link">
                        See what it costs
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="rk-fineprint">
            Moving up starts now and you pay only for the days left in this month. Moving down
            starts at your next renewal, so you keep what you already paid for.
          </p>
        </div>
      )}

      {/* ── add-on packs ── */}
      {overview.packs.length > 0 ? (
        <div className="rk-card">
          <h2>Need more this month</h2>
          <div className="rk-table-scroll">
            <table className="rk-table">
              <thead>
                <tr>
                  <th>Pack</th>
                  <th>Price</th>
                  <th>
                    <span className="rk-sr-only">Buy</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {overview.packs.map((pack) => (
                  <tr key={pack.id}>
                    <td>{pack.label}</td>
                    <td>
                      <Money kobo={pack.priceK} />
                    </td>
                    <td>
                      <form action={buyPack}>
                        <input type="hidden" name="packId" value={pack.id} />
                        <button type="submit" className="rk-btn rk-btn-quiet">
                          Buy
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="rk-fineprint">
            Packs are for this month only and do not carry over. Buy one when you need it rather
            than paying for a bigger plan every month.
          </p>
        </div>
      ) : null}

      {/* ── the statement ── */}
      <div className="rk-card">
        <h2>Billing history</h2>
        {overview.charges.length === 0 ? (
          <p className="rk-fineprint">
            Nothing charged yet. Every payment you make to Rekoda will be listed here with its
            reference, so you can put it in your own books.
          </p>
        ) : (
          <div className="rk-table-scroll">
            <table className="rk-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>What for</th>
                  <th>Reference</th>
                  <th>Status</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {overview.charges.map((charge) => (
                  <tr key={charge.reference}>
                    <td>{lagosDate(charge.createdAt)}</td>
                    <td>
                      {CHARGE_LABELS[charge.kind] ?? charge.kind}
                      {charge.plan ? ` · ${PLAN_NAMES[charge.plan] ?? charge.plan}` : ''}
                    </td>
                    <td className="rk-mono">{charge.reference}</td>
                    <td>{charge.status}</td>
                    <td>
                      <Money kobo={charge.amountK} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
