import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Stepper } from '@/components/ui/Stepper';
import { firstParam } from '@/lib/search-params';
import { readAnyStagePhone } from '@/server/verified-phone';

export const metadata: Metadata = {
  // Plain apostrophe: metadata is escaped, so an HTML entity here renders
  // literally as `You&rsquo;re ready` in the browser tab.
  title: 'You’re ready',
  robots: { index: false, follow: false },
};

/** Placeholder until the number is provisioned — ADR 0002, Rekoda's own WABA. */
const REKODA_WA = process.env.NEXT_PUBLIC_REKODA_WHATSAPP ?? '';

export default async function CompletePage({
  searchParams,
}: {
  searchParams: Promise<{ name?: string | string[] }>;
}) {
  const verified = await readAnyStagePhone();
  const name = firstParam((await searchParams).name);
  if (!verified || !name) redirect('/start');

  const waHref = REKODA_WA
    ? `https://wa.me/${REKODA_WA}?text=${encodeURIComponent('Hi Rekoda')}`
    : undefined;

  return (
    <section className="rk-container rk-onboard">
      <Stepper current={4} />
      <h1>{name} is ready</h1>
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
      </div>
    </section>
  );
}
