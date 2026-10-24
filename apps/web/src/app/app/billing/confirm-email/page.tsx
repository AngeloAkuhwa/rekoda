import type { Metadata } from 'next';
import { requireSessionWithToken } from '@/server/guards';
import { heldBy } from '@/lib/capabilities';
import { AppNav } from '../../AppNav';
import { SignOutButton } from '../../SignOutButton';
import { ConfirmEmail } from './ConfirmEmail';

export const metadata: Metadata = {
  title: 'Confirm billing email',
  // The link in the email is private to its recipient: never indexed, never cached.
  robots: { index: false, follow: false },
};

/**
 * `/app/billing/confirm-email#<token>`, opened from the email (G-102 slice 2b/2c).
 * Needs the owner's signed-in session; without one the guard sends the visitor to
 * sign in, after which they open the emailed link again (a fragment does not
 * survive the sign-in steps, by design: it is the secret).
 */
export default async function ConfirmEmailPage() {
  const { identity } = await requireSessionWithToken();
  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">Billing</p>
          <h1>Confirm your billing email</h1>
        </div>
        <SignOutButton />
      </header>
      <AppNav active="billing" held={heldBy(identity)} role={identity.role} />
      <ConfirmEmail />
    </section>
  );
}
