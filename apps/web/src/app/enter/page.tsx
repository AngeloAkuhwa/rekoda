import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { redeemMagicLink } from '@/server/api';
import { setSessionToken } from '@/server/session-cookies';

export const metadata: Metadata = {
  title: 'Signing you in',
  robots: { index: false, follow: false },
};

/**
 * The landing point of the sign-in link Rekoda sends in chat.
 *
 * A server component rather than a route handler, because the failure case
 * has to be a page a person can read: a merchant whose link went stale wants
 * a sentence and a way forward, not a 400.
 *
 * `dynamic` is not decoration. This route sets a cookie from a query string
 * and must never be prerendered or cached by anything, at any layer.
 *
 * On success it redirects immediately, which is also what gets the token out
 * of the address bar: the URL a merchant is left looking at, and the one that
 * lands in their history, is `/app`.
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

  if (token) {
    const outcome = await redeemMagicLink(token);
    if (outcome.status === 'signed_in') {
      await setSessionToken(outcome.sessionToken);
      redirect('/app');
    }
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
