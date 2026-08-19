import type { Metadata } from 'next';
import { Button } from '@/components/ui/Button';
import { Stepper } from '@/components/ui/Stepper';
import { requireSession } from '@/server/guards';

export const metadata: Metadata = {
  // Plain apostrophe: metadata is escaped, so an HTML entity here renders
  // literally as `You&rsquo;re ready` in the browser tab.
  title: 'You’re ready',
  robots: { index: false, follow: false },
};

/** Placeholder until the number is provisioned — ADR 0011, Rekoda's own WABA. */
const REKODA_WA = process.env.NEXT_PUBLIC_REKODA_WHATSAPP ?? '';

export default async function CompletePage() {
  // The business name now comes from the session, not a query param. It was
  // never a security hole — the guard was elsewhere — but a name in the URL is
  // a name anyone can change, and this page congratulates you by it.
  const identity = await requireSession();

  const waHref = REKODA_WA
    ? `https://wa.me/${REKODA_WA}?text=${encodeURIComponent('Hi Rekoda')}`
    : undefined;

  return (
    <section className="rk-container rk-onboard">
      <Stepper current={4} />
      <h1>{identity.businessName} is ready</h1>
      <p className="rk-lede">
        Now talk to Rekoda on WhatsApp. Tell it what happens in your business and the records build
        themselves.
      </p>

      <div className="rk-card rk-next">
        <h2>Try this first</h2>
        <p>Send Rekoda a message like:</p>
        <p className="rk-example">&ldquo;Sold 2 bags for 45k, customer paid cash&rdquo;</p>
        <p>It will show you what it understood and ask before recording anything.</p>
      </div>

      <div className="rk-cta-row">
        {waHref ? (
          <Button href={waHref}>Open Rekoda on WhatsApp</Button>
        ) : (
          /* Never render a dead link — say what is true instead. */
          <p className="rk-fineprint">
            Rekoda&rsquo;s WhatsApp number is being set up. You&rsquo;ll get a message here as soon
            as it&rsquo;s live.
          </p>
        )}
        <Button href="/app" variant="secondary">
          Go to your dashboard
        </Button>
      </div>
    </section>
  );
}
