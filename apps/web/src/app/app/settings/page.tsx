import type { Metadata } from 'next';
import { businessSettings, paymentInstruction } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { canRecordTrade, isOwner } from '@/lib/permissions';
import { AppNav } from '../AppNav';
import { SignOutButton } from '../SignOutButton';
import { SettingsForm } from './SettingsForm';
import { PaymentInstructionForm, PublicContactForm } from './ReminderSettingsForms';
import styles from '../reminders/reminders.module.css';
import { heldBy } from '@/lib/capabilities';

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
  /* The owner and a helper may read where reminders ask customers to pay; only the owner may
   * change it (REM-04). An accountant is not asked: the API would refuse the read. */
  const instruction = canRecordTrade(identity.role)
    ? (await paymentInstruction(token)).instruction
    : null;

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">Settings</p>
          <h1>{identity.businessName}</h1>
        </div>
        <SignOutButton />
      </header>

      <AppNav active="settings" held={heldBy(identity)} role={identity.role} />

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

      <div className="rk-card" id="reminders">
        <h2>Payment reminders</h2>
        <p className="rk-fineprint">
          What your customers see in a reminder: the phone to call and, if you add them, the bank
          details to pay into. Rekoda never makes these up and never holds the money; customers pay
          you directly.
        </p>
        {owner ? (
          <>
            <h3 className={styles.sub}>Business phone</h3>
            <PublicContactForm />
            <h3 className={styles.sub}>Bank details for customers</h3>
            {instruction ? null : (
              <p className="rk-fineprint">
                None yet. Without them, a reminder asks customers to call your business phone, so
                save a business phone above or reminders cannot be sent.
              </p>
            )}
            <PaymentInstructionForm current={instruction} />
          </>
        ) : canRecordTrade(identity.role) ? (
          <>
            {instruction ? (
              <dl className={styles.facts}>
                <div>
                  <dt>Bank</dt>
                  <dd>{instruction.bankName}</dd>
                </div>
                <div>
                  <dt>Account name</dt>
                  <dd>{instruction.accountName}</dd>
                </div>
                <div>
                  <dt>Account number</dt>
                  <dd className="rk-mono">{instruction.accountNumber}</dd>
                </div>
              </dl>
            ) : (
              <p className="rk-fineprint">
                No bank details yet. A reminder then asks customers to call the business phone, and
                none is sent until the owner has saved one.
              </p>
            )}
            <p className="rk-fineprint">
              Only the owner can change the bank details or the business phone reminders show.
            </p>
          </>
        ) : (
          <p className="rk-fineprint">
            Only the owner can set the business phone and bank details reminders show.
          </p>
        )}
      </div>

      {owner ? (
        <div className="rk-card">
          <h2>Take your books with you</h2>
          <p className="rk-fineprint">
            One file with every record this business holds: invoices, receipts, spending, stock and
            the audit trail. It is yours, so it never counts against your monthly downloads and it
            keeps working if your plan lapses. Customer contact details are not in it: those are
            released one record at a time, on the record itself.
          </p>
          <p>
            <a className="rk-btn rk-btn-quiet" href="/app/export/data" download>
              Download everything
            </a>
          </p>
        </div>
      ) : null}

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
