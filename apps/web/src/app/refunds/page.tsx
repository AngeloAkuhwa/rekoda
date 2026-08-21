import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal/LegalPage';
import { Fact } from '@/components/legal/Fact';
import { LEGAL } from '@/lib/legal';
import { canonical } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Refunds',
  description:
    'When Rekoda refunds a payment and when it does not, set out as a table rather than a paragraph you have to argue with.',
  alternates: { canonical: canonical('/refunds') },
};

/**
 * The refund policy (ADR 0024).
 *
 * Deliberately not "all payments are non-refundable". That sentence is
 * hostile to exactly the merchants this product exists for, and Nigeria's
 * consumer-protection framework emphasises fair dealing and a remedy where a
 * paid-for service is not delivered.
 *
 * A table rather than prose, because a merchant asking for their money back
 * should be able to find their own situation in one line rather than read
 * four paragraphs deciding whether one of them is about them.
 */
export default function RefundsPage() {
  return (
    <LegalPage
      title="Refunds"
      intro="When we give money back, and when we do not. Find your situation in the table; the rest is detail."
      sections={[
        {
          id: 'table',
          heading: 'The short version',
          body: (
            <div className="rk-table-scroll">
              <table className="rk-table">
                <thead>
                  <tr>
                    <th>What happened</th>
                    <th>What we do</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>You cancelled</td>
                    <td>
                      Your next renewal stops. The month you already paid for keeps working to the
                      end. No automatic cash refund of that month.
                    </td>
                  </tr>
                  <tr>
                    <td>You were charged twice, or charged the wrong amount</td>
                    <td>Full refund of the incorrect charge.</td>
                  </tr>
                  <tr>
                    <td>Rekoda failed you and we could not put it right</td>
                    <td>Full or part refund, depending on how much of the month you lost.</td>
                  </tr>
                  <tr>
                    <td>You bought an add-on pack and have not used any of it</td>
                    <td>Refundable within 7 days.</td>
                  </tr>
                  <tr>
                    <td>You bought an add-on pack and have started using it</td>
                    <td>Not refundable. You have had the thing you bought.</td>
                  </tr>
                  <tr>
                    <td>We suspended you for breaking the rules</td>
                    <td>No refund from the suspension itself, subject to your legal rights.</td>
                  </tr>
                  <tr>
                    <td>We suspended you and we were wrong</td>
                    <td>Access back, and a refund or credit for what you lost.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ),
        },
        {
          id: 'cancelling',
          heading: 'Cancelling',
          body: (
            <>
              <p>
                Cancelling stops the next charge. It does not delete anything and it does not lock
                you out of the month you have already paid for.
              </p>
              <p>
                When that month ends, your account goes read-only rather than closed. You can still
                open the dashboard, read your books, and export them as CSV, PDF or Excel. How long
                we keep them is set out in <a href="/privacy#retention">how long we keep things</a>.
              </p>
            </>
          ),
        },
        {
          id: 'packs',
          heading: 'Add-on packs',
          body: (
            <p>
              A pack is capacity for the month you buy it in, and it does not carry over. Untouched
              within 7 days, we refund it. Once any of it has been used, it is not refundable: the
              messages were sent, or the documents were made, and those cost us whether or not you
              wanted them afterwards.
            </p>
          ),
        },
        {
          id: 'fees',
          heading: 'Payment fees are not ours to refund',
          body: (
            <p>
              When your customers pay you through Rekoda, your payment provider takes its own fee
              and settles the rest straight to your bank. Rekoda never holds that money, so we
              cannot refund a provider fee. Those fees are always shown separately in your books
              rather than netted off your income.
            </p>
          ),
        },
        {
          id: 'asking',
          heading: 'How to ask',
          body: (
            <>
              <p>
                Message <strong>refund</strong> on WhatsApp, or write to{' '}
                <Fact fact={LEGAL.supportEmail} />, with the reference from your{' '}
                <a href="/app/billing">billing history</a>. Every charge Rekoda makes has one, and
                it is the fastest way for us to find the payment.
              </p>
              <p>
                We answer within 5 working days. If we agree a refund, it goes back to the account
                that paid, and how long your bank takes after that is your bank&apos;s business
                rather than ours.
              </p>
            </>
          ),
        },
        {
          id: 'rights',
          heading: 'Your legal rights',
          body: (
            <p>
              Nothing here takes away rights you have under Nigerian consumer-protection law. Where
              this page and the law disagree, the law wins. These terms are with{' '}
              <Fact fact={LEGAL.entity} />.
            </p>
          ),
        },
      ]}
    />
  );
}
