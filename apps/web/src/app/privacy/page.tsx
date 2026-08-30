import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal/LegalPage';
import { Fact } from '@/components/legal/Fact';
import { FINANCIAL_RETENTION_YEARS, LEGAL, RETENTION } from '@/lib/legal';
import { canonical } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Privacy',
  description:
    'What Rekoda collects, why, how long it is kept, and how to get it deleted. Written to be read rather than to be defensible.',
  alternates: { canonical: canonical('/privacy') },
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy"
      intro="What we collect, why we collect it, and how to get rid of it. Nigerian data protection law (the NDPA) gives you rights over all of it."
      sections={[
        {
          id: 'who',
          heading: 'Who is responsible',
          body: (
            <p>
              Rekoda is operated by <Fact fact={LEGAL.entity} />
              {LEGAL.rcNumber.value ? <> (RC {LEGAL.rcNumber.value})</> : null}, at{' '}
              <Fact fact={LEGAL.address} />. For anything on this page, write to{' '}
              <Fact fact={LEGAL.privacyEmail} />.
            </p>
          ),
        },
        {
          id: 'collect',
          heading: 'What we collect',
          body: (
            <>
              <ul>
                <li>
                  <strong>Your WhatsApp number.</strong> It is how you sign in, and how Rekoda
                  reaches you. There is no password.
                </li>
                <li>
                  <strong>Your business name and type</strong>, as you type them. We do not require
                  CAC registration or a TIN.
                </li>
                <li>
                  <strong>What you tell Rekoda</strong>: messages and voice notes about sales,
                  expenses, stock and customers, plus the records built from them.
                </li>
                <li>
                  <strong>Your customers&rsquo; details</strong>, when you give them to us so an
                  invoice or receipt can be addressed. These are encrypted at rest. Where you have
                  connected your own WhatsApp Business number, a customer who replies{' '}
                  <strong>STOP</strong> on that number stops receiving messages from your shop until
                  they reply <strong>START</strong>.
                </li>
                <li>
                  <strong>Payment events</strong> from your own payment provider: that a payment
                  arrived, how much, and when. Not your card details, which we never see.
                </li>
              </ul>
              <p>
                We do not collect your location, your contacts, or anything from your phone beyond
                the messages you deliberately send.
              </p>
            </>
          ),
        },
        {
          id: 'why',
          heading: 'Why we are allowed to hold it',
          body: (
            <p>
              Mostly because you asked us to keep your books; we cannot provide the service without
              the records it is made of. Some of it we must keep by law: Nigerian tax and company
              law requires financial records to survive for {FINANCIAL_RETENTION_YEARS} years, and
              that obligation outlives your account.
            </p>
          ),
        },
        {
          id: 'sharing',
          heading: 'Who else sees it',
          body: (
            <>
              <ul>
                <li>
                  <strong>Meta (WhatsApp)</strong> carries the messages, as it does for every
                  WhatsApp conversation you have.
                </li>
                <li>
                  <strong>Your payment provider</strong>: your own account, which you control.
                </li>
                <li>
                  <strong>Anthropic</strong>, our reasoning AI provider, sees your message text with
                  supported customer identifiers already replaced by tokens. When document reading
                  is enabled, it also receives photographed receipts and invoices, solely to read
                  them into text. See <a href="/ai-privacy">AI &amp; privacy</a>.
                </li>
                <li>
                  <strong>OpenAI</strong>, our transcription provider, receives your voice notes
                  when voice transcription is enabled, solely to turn them into text. The audio is
                  not kept, and the text is protected like any typed message before AI reasons about
                  it.
                </li>
              </ul>
              <p>
                We do not sell your data, and we do not share it for advertising. Nobody buys a list
                from us because we do not have one to sell.
              </p>
            </>
          ),
        },
        {
          id: 'retention',
          heading: 'How long we keep it',
          body: (
            <>
              <p>
                A schedule rather than a promise to keep things forever. Two rules pull against each
                other and this is where they meet: tax law expects business books to survive for
                years, and data-protection law says personal information should not outlive the
                reason it was collected.
              </p>
              <div className="rk-table-scroll">
                <table className="rk-table">
                  <thead>
                    <tr>
                      <th>What</th>
                      <th>How long</th>
                      <th>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Invoices, receipts, ledger entries</td>
                      <td>{RETENTION.financialYears} years</td>
                      <td>Nigerian tax law expects your books to be available for that long.</td>
                    </tr>
                    <tr>
                      <td>Chat history and drafts</td>
                      <td>While your account is open, then {RETENTION.conversationDays} days</td>
                      <td>They are how the records were made, not records themselves.</td>
                    </tr>
                    <tr>
                      <td>Voice notes</td>
                      <td>Not kept</td>
                      <td>Turned into text and deleted in the same request. Never stored.</td>
                    </tr>
                    <tr>
                      <td>A trial you never converted</td>
                      <td>{RETENTION.abandonedTrialDays} days after it ends</td>
                      <td>Long enough to come back or export. Not forever.</td>
                    </tr>
                    <tr>
                      <td>Payment screenshots customers send</td>
                      <td>
                        Until the claim is settled or {RETENTION.evidenceResolutionDays} days pass
                        unanswered, then the image is deleted {RETENTION.evidenceRawDays} days later
                      </td>
                      <td>
                        A screenshot proves a claim was made, never a payment. The claim and its
                        outcome stay with your books; the picture does not need to.
                      </td>
                    </tr>
                    <tr>
                      <td>Customer names, phones and addresses</td>
                      <td>While you need them, or until you ask us to erase them</td>
                      <td>Encrypted separately from the books throughout.</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p>
                Nothing on this schedule is deleted without warning: you get at least{' '}
                {RETENTION.noticeDays} days&apos; notice on the number and email we have for you.
              </p>
              <p>
                If you stop paying, your account becomes read-only rather than closed. You can open
                the dashboard, read your books and export them, for as long as this schedule keeps
                them.
              </p>
              <p>
                This is the honest carve-out: if you ask us to delete everything, we delete
                everything we are permitted to, and keep the financial records we are obliged to
                keep, in a form that is no longer linked to marketing or analytics. We will tell you
                exactly what was kept and why.
              </p>
            </>
          ),
        },
        {
          id: 'rights',
          heading: 'Your rights',
          body: (
            <>
              <p>
                You do not have to ask for a copy of your data. Sign in and download it: Settings
                has one file with every record your business holds. It is your data, so it never
                counts against your monthly downloads, and it keeps working if your subscription
                lapses.
              </p>
              <p>
                You can also ask us to correct your data, or ask us to delete it, see{' '}
                <a href="/data-deletion">Delete my data</a>. You can withdraw consent at any time by
                replying <strong>STOP</strong> on WhatsApp, which ends the messages without
                destroying the books you may still need.
              </p>
            </>
          ),
        },
        {
          id: 'ndpr',
          heading: 'Compliance filings',
          body: (
            <p>
              NDPA audit filing: <Fact fact={LEGAL.ndprAuditor} />.
            </p>
          ),
        },
      ]}
    />
  );
}
