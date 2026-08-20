import type { Metadata } from 'next';
import { Button } from '@/components/ui/Button';
import { requireSession } from '@/server/guards';
import { SignOutButton } from './SignOutButton';

export const metadata: Metadata = {
  title: 'Your dashboard',
  robots: { index: false, follow: false },
};

/**
 * The dashboard shell: the first authenticated surface, and the end of the M1
 * journey (phone → OTP → business → dashboard).
 *
 * The numbers are deliberately absent rather than faked. A shell that renders
 * plausible figures before the transaction engine exists teaches a merchant to
 * trust a number Rekoda did not compute — which is the one habit this product
 * cannot afford to build.
 */
export default async function DashboardPage() {
  const identity = await requireSession();

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">{identity.plan === 'trial' ? 'Free trial' : identity.plan}</p>
          <h1>{identity.businessName}</h1>
          <p className="rk-fineprint">
            Signed in as {identity.phone} · {identity.role}
          </p>
        </div>
        <SignOutButton />
      </header>

      <div className="rk-stat-grid">
        <StatTile label="Money in" hint="Payments you have confirmed" />
        <StatTile label="Money out" hint="Expenses and stock you have recorded" />
        <StatTile label="Owed to you" hint="Invoices still unpaid" />
      </div>

      <div className="rk-cta-row">
        <Button href="/app/payments" variant="secondary">
          Payments
        </Button>
      </div>

      <div className="rk-card rk-dash-empty">
        <h2>Nothing recorded yet</h2>
        <p>
          Rekoda builds your records from what you tell it on WhatsApp. Send your first sale and it
          appears here, with the working shown so you can check every figure.
        </p>
      </div>
    </section>
  );
}

/**
 * An empty state, not a zero.
 *
 * "₦0" is a claim — it says Rekoda looked and found nothing. Before any
 * transaction exists the honest thing to show is that there is nothing to total
 * yet. The three money states (spec §7) are confirmed, pending and unknown, and
 * this is unknown, so it must not borrow the typography of a confirmed figure.
 * Words, not a dash glyph: a bare dash reads as either "zero" or "broken".
 */
function StatTile({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="rk-stat">
      <p className="rk-stat-label">{label}</p>
      <p className="rk-stat-empty" aria-label={`${label}: nothing recorded yet`}>
        none yet
      </p>
      <p className="rk-fineprint">{hint}</p>
    </div>
  );
}
