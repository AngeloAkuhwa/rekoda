import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal/LegalPage';
import { Fact } from '@/components/legal/Fact';
import { LEGAL } from '@/lib/legal';
import { canonical } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Terms',
  description:
    'The agreement between you and Rekoda: what the service does, what it does not promise, how billing and cancellation work, and who owns your records.',
  alternates: { canonical: canonical('/terms') },
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of service"
      intro="The agreement between you and Rekoda. Written plainly, because a term you cannot understand is a term you cannot agree to."
      sections={[
        {
          id: 'parties',
          heading: 'Who this is between',
          body: (
            <p>
              These terms are between you — the business using Rekoda — and{' '}
              <Fact fact={LEGAL.entity} />. Using Rekoda means accepting them. Questions go to{' '}
              <Fact fact={LEGAL.supportEmail} />.
            </p>
          ),
        },
        {
          id: 'service',
          heading: 'What Rekoda does',
          body: (
            <p>
              Rekoda turns what you tell it into financial records: invoices, receipts, a
              double-entry ledger, and reports built from them. It reads payment events from your
              own payment account so it can tell you whether money actually arrived.
            </p>
          ),
        },
        {
          id: 'not',
          heading: 'What Rekoda is not',
          body: (
            <>
              <p>
                <strong>Rekoda is not your accountant, and not a bank.</strong> It keeps books that
                an accountant can work from; it does not give tax, legal or financial advice, and
                filing your returns remains yours to do.
              </p>
              <p>
                Rekoda never holds your money. Payments settle into your own account with your own
                provider, under your agreement with them.
              </p>
              <p>
                Where Rekoda reports that a payment is unverified, that is information, not a
                guarantee. The decision to release goods is always yours.
              </p>
            </>
          ),
        },
        {
          id: 'yours',
          heading: 'Your records belong to you',
          body: (
            <p>
              Everything Rekoda builds from your business is yours. You can export it at any time,
              and you keep that right after you stop paying — we will not hold your books hostage to
              a subscription.
            </p>
          ),
        },
        {
          id: 'accuracy',
          heading: 'Accuracy, and your part in it',
          body: (
            <p>
              Rekoda shows you what it understood and asks before recording. Once you confirm an
              entry, it is your record. Please check the figures — particularly when a message was
              ambiguous and Rekoda said so.
            </p>
          ),
        },
        {
          id: 'billing',
          heading: 'Billing and cancellation',
          body: (
            <p>
              The trial runs 30 days and needs no card. After that, plans are billed monthly in
              advance and you can cancel at any time, which stops the next charge and leaves your
              access running to the end of the period already paid for. Payment processing fees
              charged by your own provider are theirs, not ours, and are always shown separately.
            </p>
          ),
        },
        {
          id: 'acceptable',
          heading: 'Fair use',
          body: (
            <p>
              Do not use Rekoda to record transactions that are not real, to send messages people
              have not asked for, or to break Nigerian law or WhatsApp&rsquo;s own rules. We may
              suspend an account doing any of these, and we will say why.
            </p>
          ),
        },
        {
          id: 'liability',
          heading: 'Liability',
          body: (
            <p>
              Rekoda is provided as it is. To the extent Nigerian law allows, our liability for any
              claim is limited to the fees you paid us in the twelve months before it arose. Nothing
              here limits liability that cannot lawfully be limited.
            </p>
          ),
        },
        {
          id: 'changes',
          heading: 'Changes',
          body: (
            <p>
              If these terms change in a way that materially affects you, we will tell you on
              WhatsApp before it takes effect — not by quietly editing this page.
            </p>
          ),
        },
      ]}
    />
  );
}
