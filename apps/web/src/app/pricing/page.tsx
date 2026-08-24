import type { Metadata } from 'next';
import { canonical } from '@/lib/site';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { PLANS, TRIAL } from '@/lib/plans';

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Rekoda plans from ₦9,900/month. 30-day free trial, no card needed. Paystack processing fees are shown separately and always yours.',
  alternates: { canonical: canonical('/pricing') },
};

export default function PricingPage() {
  return (
    <>
      <section className="rk-hero rk-container">
        <h1>Priced against an accountant&rsquo;s afternoon</h1>
        <p className="rk-lede">
          Every plan includes the full books. What changes is how your business reaches Rekoda: you
          tell it, your shop tells it, or both.
        </p>
      </section>

      <section className="rk-container">
        <div className="rk-card rk-trial">
          <div>
            <h2>{TRIAL.name}</h2>
            <p className="rk-trial-tag">{TRIAL.tagline}</p>
          </div>
          <ul className="rk-features">
            {TRIAL.includes.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <Button href="/start">Start free</Button>
        </div>
      </section>

      <section className="rk-section rk-container">
        <div className="rk-grid rk-grid-3">
          {PLANS.map((plan) => (
            <article
              key={plan.id}
              className={`rk-card rk-plan${plan.highlight ? ' rk-plan-featured' : ''}`}
            >
              {plan.highlight ? <p className="rk-plan-flag">Most popular</p> : null}
              <h3>{plan.name}</h3>
              <p className="rk-plan-tagline">{plan.tagline}</p>

              <p className="rk-plan-price">
                <Money kobo={plan.monthlyK} />
                <span className="rk-plan-per">/month</span>
              </p>
              <p className="rk-plan-annual">
                or <Money kobo={plan.annualK} /> a year (two months free)
              </p>

              <Button
                href={`/start?plan=${plan.id}`}
                variant={plan.highlight ? 'primary' : 'secondary'}
              >
                {plan.cta}
              </Button>

              <ul className="rk-features">
                {plan.includes.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>

              {plan.coming?.length ? (
                <>
                  <p className="rk-fineprint rk-plan-coming-label">Coming soon</p>
                  <ul className="rk-features rk-features-out">
                    {plan.coming.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </>
              ) : null}

              {plan.excludes?.length ? (
                <ul className="rk-features rk-features-out">
                  {plan.excludes.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      {/* Transparency is product behaviour, not marketing (MASTER-PLAN Part 8). */}
      <section className="rk-section rk-container">
        <h2>What you also pay, and to whom</h2>
        <p>
          <strong>Payment processing is not included, and it is not ours.</strong> When a customer
          pays you by transfer, Paystack charges <strong>1.5% + ₦100</strong>, capped at{' '}
          <strong>₦2,000</strong> (the ₦100 is waived under ₦2,500). That goes to Paystack, from
          your own Paystack account.
        </p>
        <p style={{ marginTop: 'var(--rk-space-3)' }}>
          Rekoda never holds your money. Payments settle straight into your account, and your
          subscription pays for the records, the reconciliation and the verification. Never for
          moving your money.
        </p>
      </section>
    </>
  );
}
