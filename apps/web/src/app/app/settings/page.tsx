import type { Metadata } from 'next';
import { businessSettings } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { isOwner } from '@/lib/permissions';
import { AppNav } from '../AppNav';
import { SignOutButton } from '../SignOutButton';
import { SettingsForm } from './SettingsForm';

export const metadata: Metadata = {
  title: 'Settings',
  robots: { index: false, follow: false },
};

/**
 * The facts of the business itself (fix-plan 5, H2a).
 *
 * Onboarding has said "you can change it" about the name and "later from
 * settings" about CAC and TIN since M1; this is the page those sentences
 * were pointing at. Owner-only for the writes, and the page says so to
 * everyone else instead of showing controls that will refuse.
 */
export default async function SettingsPage() {
  const { identity, token } = await requireSessionWithToken();
  const owner = isOwner(identity.role);
  const settings = owner ? await businessSettings(token) : null;

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">Settings</p>
          <h1>{identity.businessName}</h1>
        </div>
        <SignOutButton />
      </header>

      <AppNav active="settings" />

      <div className="rk-card">
        <h2>Your business</h2>
        {owner && settings ? (
          <>
            <p className="rk-fineprint">
              Signed up with <strong>{settings.phone}</strong>
              {settings.businessType ? <> · {settings.businessType}</> : null}. The number cannot be
              changed here, because it is how you sign in and where Rekoda talks to you.
            </p>
            <SettingsForm name={settings.name} rcNumber={settings.rcNumber} tin={settings.tin} />
          </>
        ) : (
          <p className="rk-fineprint">
            Only the owner can change the business name, CAC number or TIN. Everything else about
            your access is on the team page.
          </p>
        )}
      </div>

      <div className="rk-card">
        <h2>Your plan, your money, your team</h2>
        <p className="rk-fineprint">
          Plan changes, add-on packs and cancelling live on the{' '}
          <a href="/app/billing">billing page</a>. Who can see these books lives on the{' '}
          <a href="/app/team">team page</a>. Your shop page lives with the{' '}
          <a href="/app/catalogue">catalogue</a>.
        </p>
      </div>
    </section>
  );
}
