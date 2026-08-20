import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal/LegalPage';
import { Fact } from '@/components/legal/Fact';
import { FINANCIAL_RETENTION_YEARS, LEGAL } from '@/lib/legal';
import { canonical } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Delete my data',
  description:
    'How to have your Rekoda data deleted, what happens when you ask, and the financial records Nigerian law requires us to keep even then.',
  alternates: { canonical: canonical('/data-deletion') },
};

export default function DataDeletionPage() {
  return (
    <LegalPage
      title="Delete my data"
      intro="How to have your data removed, what actually gets removed, and the one thing we are required to keep."
      sections={[
        {
          id: 'how',
          heading: 'How to ask',
          body: (
            <>
              <p>Either way works, and both reach a person:</p>
              <ul>
                <li>
                  Message <strong>DELETE MY DATA</strong> to Rekoda on WhatsApp, from the number on
                  the account.
                </li>
                <li>
                  Or email <Fact fact={LEGAL.privacyEmail} /> from the address you use with us.
                </li>
              </ul>
              <p>
                We confirm it is really you before deleting anything, because a deletion request
                nobody verified is just a way to erase someone else&rsquo;s books.
              </p>
            </>
          ),
        },
        {
          id: 'when',
          heading: 'What happens, and how fast',
          body: (
            <p>
              We acknowledge within 48 hours and complete the deletion within 30 days, which is what
              the NDPA allows. You get a written confirmation listing what was deleted and what was
              kept.
            </p>
          ),
        },
        {
          id: 'deleted',
          heading: 'What is deleted',
          body: (
            <ul>
              <li>
                Your customers&rsquo; names, numbers and addresses are deleted immediately when you
                send <strong>DELETE MY DATA</strong> on WhatsApp and confirm.
              </li>
              <li>Your conversations with Rekoda.</li>
              <li>Your business profile and settings.</li>
              <li>Your sign-in history and sessions.</li>
              <li>Connections to your payment provider and WhatsApp catalogue.</li>
            </ul>
          ),
        },
        {
          id: 'kept',
          heading: 'What we must keep, and why',
          body: (
            <>
              <p>
                Nigerian tax and company law requires financial records to be retained for{' '}
                {FINANCIAL_RETENTION_YEARS} years. So invoices, receipts and ledger entries survive
                a deletion request until that period ends. We are not permitted to destroy them, and
                neither is any other bookkeeping service that tells you otherwise.
              </p>
              <p>
                What we can do, and do: strip them of the customer identities attached to them, and
                remove them from everything that is not that legal obligation. They are no longer
                used, analysed, or reachable from your account. When the {FINANCIAL_RETENTION_YEARS}{' '}
                years elapse, they are destroyed too.
              </p>
            </>
          ),
        },
        {
          id: 'stop',
          heading: 'If you only want the messages to stop',
          body: (
            <p>
              Reply <strong>STOP</strong> on WhatsApp. That ends the messages immediately and keeps
              your records intact, which is usually what people actually want. Reply{' '}
              <strong>START</strong> to resume.
            </p>
          ),
        },
      ]}
    />
  );
}
