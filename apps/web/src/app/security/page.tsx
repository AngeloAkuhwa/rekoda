import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal/LegalPage';
import { canonical } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Security',
  description:
    'How Rekoda protects your records: per-business isolation enforced by the database, hashed credentials, encrypted provider keys, and point-in-time backups.',
  alternates: { canonical: canonical('/security') },
};

export default function SecurityPage() {
  return (
    <LegalPage
      title="Security"
      intro="Your books are only useful if you can trust them. Here is what actually protects them — described precisely enough that you could check it."
      sections={[
        {
          id: 'isolation',
          heading: 'One business can never see another',
          body: (
            <>
              <p>
                Every record carries the business it belongs to, and the database itself refuses to
                return rows from any other business — the rule lives in PostgreSQL, not only in our
                code. An application query that forgets to filter returns <strong>nothing</strong>,
                rather than someone else&rsquo;s ledger.
              </p>
              <p>
                Rekoda connects as a role that is not the table owner and cannot switch that rule
                off. We test this the only way it can honestly be tested: two businesses sharing one
                database connection, checking that neither sees the other.
              </p>
            </>
          ),
        },
        {
          id: 'credentials',
          heading: 'We cannot read your codes or your keys',
          body: (
            <>
              <p>
                There is no password to steal, because Rekoda has none. You sign in with a code sent
                to your WhatsApp number. That code is never stored — only a keyed hash of it, using
                a secret held outside the database, so a copy of the database alone will not reveal
                a working code.
              </p>
              <p>
                Session tokens are stored the same way. Payment provider keys are encrypted before
                they are written down, and are never logged, echoed back, or shown in the dashboard.
              </p>
            </>
          ),
        },
        {
          id: 'money',
          heading: 'Rekoda never holds your money',
          body: (
            <p>
              Payments go to your own Paystack account, settling to your own bank account. Rekoda
              reads what happened so it can build your records; it is never a step the money passes
              through. If Rekoda disappeared tomorrow, your money would be unaffected.
            </p>
          ),
        },
        {
          id: 'history',
          heading: 'Records are added to, not rewritten',
          body: (
            <p>
              The ledger, stock movements and the audit trail are append-only — the application is
              not permitted to update or delete them, and that permission is withheld by the
              database. A correction is recorded as a correction, so the history of a figure stays
              readable.
            </p>
          ),
        },
        {
          id: 'backups',
          heading: 'Backups and recovery',
          body: (
            <p>
              Continuous archiving lets us restore to a point in time, rather than to whenever the
              last nightly dump happened. Restores are rehearsed rather than assumed, and the
              rehearsal checks that the restored ledger still balances.
            </p>
          ),
        },
        {
          id: 'reporting',
          heading: 'Reporting a vulnerability',
          body: (
            <p>
              If you find a security problem, please report it before disclosing it publicly. See{' '}
              <a href="https://github.com/AngeloAkuhwa/rekoda/blob/main/SECURITY.md">SECURITY.md</a>{' '}
              for how to reach us. We will not pursue anyone acting in good faith.
            </p>
          ),
        },
      ]}
    />
  );
}
