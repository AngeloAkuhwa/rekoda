import type { Metadata } from 'next';
import { isOwner } from '@/lib/permissions';
import { Money } from '@/components/ui/Money';
import { PendingButton } from '@/components/ui/PendingButton';
import { CancelForm } from './CancelForm';
import { PLANS, PLAN_NAMES, SHARED_ACROSS_PLANS } from '@/lib/plans';
import { capabilityWords, entitlementsForPlan, planSwitch } from '@rekoda/core';
import { billingOverview, billingQuote } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { AppNav } from '../AppNav';
import { SignOutButton } from '../SignOutButton';
import { buyPack, confirmPlanChange } from './actions';
import { heldBy } from '@/lib/capabilities';

export const metadata: Metadata = {
  title: 'Billing',
  robots: { index: false, follow: false },
};

/* The overview's vocabulary, verbatim. Two pages naming the same meter two
   different ways ("documents read" here, "document scans" there) makes a
   merchant wonder if they are two meters. */
const UNIT_LABELS: Record<string, string> = {
  AI_ACTIONS: 'messages',
  VOICE_MINUTES: 'seconds of voice notes',
  DOCUMENT_GENERATION: 'invoices and receipts',
  DOCUMENTS_UNDERSTOOD: 'document scans',
  SERVICE_MESSAGE: 'replies inside the 24-hour window',
  UTILITY_TEMPLATE: 'order and payment updates',
  AUTH_TEMPLATE: 'login codes',
  AUTH_INTL_TEMPLATE: 'international login codes',
  MARKETING_TEMPLATE: 'marketing messages',
  CATALOGUE_ORDERS: 'orders',
  PAYMENT_CONNECTIONS: 'payment connections',
  FINANCIAL_ACCOUNT_CONNECTIONS: 'bank connections',
  ACCOUNTANT_USERS: 'accountant logins',
  REPORT_EXPORTS: 'report downloads',
  API_REQUEST_UNITS: 'API requests',
  API_APPLICATIONS: 'API applications',
  WEBHOOK_DELIVERIES: 'webhook deliveries',
};

const CHARGE_LABELS: Record<string, string> = {
  first_purchase: 'Subscription',
  renewal: 'Renewal',
  upgrade: 'Plan upgrade',
  add_on: 'Add-on pack',
  seat: 'Extra seat',
};

/* The status column was the one cell on this table printing the database's
 * own word: a merchant reconciling their bill read `succeeded` beside four
 * columns of plain language. */
const CHARGE_STATUS: Record<string, string> = {
  pending: 'Awaiting payment',
  succeeded: 'Paid',
  failed: 'Failed',
  abandoned: 'Not completed',
  refunded: 'Refunded',
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
  view_only:
    "Plan changes are the owner's to make, and your access is view only. Nothing was charged.",
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
  const { identity, token } = await requireSessionWithToken();
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

      <AppNav active="billing" held={heldBy(identity)} role={identity.role} />

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
        {overview.pendingPlan === 'expired' ? (
          <p className="rk-fineprint">
            Cancelled: your plan runs to the end of what you paid for, then stops without charging.
            Changed your mind? Pick your current plan on the change table below and it carries on.
          </p>
        ) : overview.pendingPlan ? (
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

          {/* ── what changes, before what it costs ──
              A plan change is a SWITCH: Chat to Integrate both gains and
              loses, and a merchant must never learn what they gave up from a
              refusal a week later (owner decision, 26 Aug 2026). Shown above
              the money on purpose. The figure is the easy part; the
              capability is the decision. */}
          {(() => {
            const change = planSwitch(overview.plan, proposed.to, entitlementsForPlan);
            if (change.gained.length === 0 && change.lost.length === 0) return null;
            return (
              <div className="rk-switch-impact">
                {change.gained.length > 0 ? (
                  <>
                    <h3>What you gain</h3>
                    <ul>
                      {change.gained.map((capability) => (
                        <li key={capability}>{capabilityWords(capability)}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {change.lost.length > 0 ? (
                  <>
                    <h3>What you lose</h3>
                    <ul>
                      {change.lost.map((capability) => (
                        <li key={capability}>{capabilityWords(capability)}</li>
                      ))}
                    </ul>
                    <p className="rk-fineprint">
                      Nothing you recorded is deleted. Your books, invoices, receipts, customers and
                      reports stay exactly as they are, and your dashboard keeps working.
                    </p>
                  </>
                ) : null}
              </div>
            );
          })()}
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
          {isOwner(identity.role) ? (
            <form action={confirmPlanChange}>
              <input type="hidden" name="plan" value={proposed.to} />
              <PendingButton pendingLabel="Confirming…">
                {proposed.amountK === 0 ? 'Confirm the switch' : 'Confirm and pay'}
              </PendingButton>{' '}
              <a href="/app/billing" className="rk-period-link">
                Not now
              </a>
            </form>
          ) : (
            <p className="rk-fineprint">Plan changes are the owner&rsquo;s to confirm.</p>
          )}
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
                  <th className="rk-num">A month</th>
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
                    <td className="rk-num">
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
          <div className="rk-shared-note">
            <h3>On every plan</h3>
            <ul>
              {SHARED_ACROSS_PLANS.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <p className="rk-fineprint">
            Moving up starts now and you pay only for the days left in this month. Moving down
            starts at your next renewal, so you keep what you already paid for.
          </p>
        </div>
      )}

      {/* ── recurring add-ons held ── */}
      {overview.addOns.length > 0 ? (
        <div className="rk-card">
          <h2>What you also subscribe to</h2>
          <div className="rk-table-scroll">
            <table className="rk-table">
              <thead>
                <tr>
                  <th>Add-on</th>
                  <th>Since</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {overview.addOns.map((addOn) => (
                  <tr key={addOn.addOnId}>
                    <td>{addOn.name}</td>
                    <td>{new Date(addOn.startedAt).toLocaleDateString('en-NG')}</td>
                    <td>
                      {addOn.endsAt
                        ? `Ends ${new Date(addOn.endsAt).toLocaleDateString('en-NG')}`
                        : 'Renews monthly'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="rk-fineprint">
            These renew every month alongside your plan. To change one, message us and we will
            handle it on your next renewal.
          </p>
        </div>
      ) : null}

      {/* ── add-on packs ── */}
      {overview.packs.length > 0 ? (
        <div className="rk-card">
          <h2>Need more this month</h2>
          <div className="rk-table-scroll">
            <table className="rk-table">
              <thead>
                <tr>
                  <th>Pack</th>
                  <th className="rk-num">Price</th>
                  <th>
                    <span className="rk-sr-only">Buy</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {overview.packs.map((pack) => (
                  <tr key={pack.id}>
                    <td>{pack.label}</td>
                    <td className="rk-num">
                      <Money kobo={pack.priceK} />
                    </td>
                    <td>
                      {isOwner(identity.role) ? (
                        <form action={buyPack}>
                          <input type="hidden" name="packId" value={pack.id} />
                          <PendingButton pendingLabel="Buying…" className="rk-btn rk-btn-quiet">
                            Buy
                          </PendingButton>
                        </form>
                      ) : (
                        <span className="rk-fineprint">Owner only</span>
                      )}
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
                  <th className="rk-num">Amount</th>
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
                    <td>{CHARGE_STATUS[charge.status] ?? charge.status}</td>
                    <td>
                      <Money kobo={charge.amountK} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* The empty state above promises every payment will be listed
                here "so you can put it in your own books". A silent cap
                breaks that promise for anybody reconciling against it. */}
            {overview.chargesTotal > overview.charges.length ? (
              <p className="rk-fineprint">
                {overview.chargesTotal} charges all time, showing the latest{' '}
                {overview.charges.length}.
              </p>
            ) : null}
          </div>
        )}
      </div>

      {/* ── leaving ── */}
      {isOwner(identity.role) &&
      overview.plan !== 'expired' &&
      overview.pendingPlan !== 'expired' ? (
        <div className="rk-card">
          <h2>Leaving Rekoda</h2>
          <p className="rk-fineprint">
            Cancelling stops the next charge and nothing else: your plan runs to the last day you
            paid for, and your records stay yours afterwards, readable and exportable, exactly as
            the terms say. Nothing is deleted by cancelling.
          </p>
          <details className="rk-void">
            <summary>Cancel my subscription</summary>
            <CancelForm />
          </details>
        </div>
      ) : null}
    </section>
  );
}
