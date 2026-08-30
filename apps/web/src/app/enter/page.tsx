import type { Metadata } from 'next';
import { Button } from '@/components/ui/Button';
import { enterAction } from './actions';

export const metadata: Metadata = {
  title: 'Signing you in',
  robots: { index: false, follow: false },
};

/**
 * The landing point of the sign-in link Rekoda sends in chat.
 *
 * This page CONSUMES NOTHING (remediation R6). It used to redeem the token
 * while rendering, which meant a GET spent a single-use credential: any
 * WhatsApp link preview, security scanner or mail crawler that followed the
 * URL burned the merchant's link before they tapped it, and they arrived to
 * be told it had expired. The redemption now lives in a server action, which
 * is a POST, so only a deliberate tap spends anything and the cookie is set
 * from a mutation rather than from a render.
 *
 * A server component rather than a route handler, because the failure case
 * has to be a page a person can read: a merchant whose link went stale wants
 * a sentence and a way forward, not a 400.
 *
 * `dynamic` is not decoration. This route reads a query string and must never
 * be prerendered or cached by anything, at any layer.
 */
export const dynamic = 'force-dynamic';

export default async function EnterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params['t'];
  const token = typeof raw === 'string' ? raw : null;
  const spent = params['spent'] !== undefined;

  if (token && !spent) {
    return (
      <section className="rk-container rk-dash">
        <div className="rk-card" style={{ marginTop: '4rem' }}>
          <h1>Open your dashboard</h1>
          <p>
            Tap the button to finish signing in. The link is not used up until you do, so a preview
            of this page in your chat app costs you nothing.
          </p>
          <form action={enterAction}>
            <input type="hidden" name="token" value={token} />
            <Button type="submit">Open my dashboard</Button>
          </form>
          <p className="rk-fineprint">Sign-in links work once and last about fifteen minutes.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="rk-container rk-dash">
      <div className="rk-card" style={{ marginTop: '4rem' }}>
        <h1>That link has expired</h1>
        {/* One sentence for all three failures on purpose: expired, already
            used, and never existed must look identical, or the page tells
            somebody guessing which of the three they achieved. */}
        <p>
          Sign-in links work once and last about fifteen minutes. Ask Rekoda for a new one on
          WhatsApp: send <strong>dashboard</strong> and tap the link it sends back.
        </p>
        <p className="rk-fineprint">
          You can also <a href="/start">sign in with your phone number</a> and we will send you a
          code.
        </p>
      </div>
    </section>
  );
}
