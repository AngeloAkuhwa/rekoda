import { computeMoney } from '@rekoda/core';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { MoneyBadge } from '@/components/ui/MoneyBadge';
import { StructuredData, faqSchema, softwareApplicationSchema } from '@/components/StructuredData';

/**
 * The hero shows a real conversation, because the product IS a conversation.
 * Every figure below is computed by @rekoda/core at build time — the marketing
 * page cannot drift from the engine, and no number here was typed by hand.
 */
const demo = computeMoney({
  items: [{ name: 'Wig', quantity: 3, unitPriceNaira: 50_000 }],
  amountPaidNaira: 100_000,
});

/**
 * The questions merchants actually ask, answered honestly.
 *
 * These double as `FAQPage` structured data, so the same text is what a
 * merchant reads and what a search engine quotes — there is no separately
 * maintained SEO copy to drift from the truth.
 */
const FAQS = [
  {
    question: 'Do I need a registered business or a CAC number to use Rekoda?',
    answer:
      'No. Rekoda never asks for CAC registration or a TIN, and it never will. Most WhatsApp vendors have neither, and requiring them would exclude exactly the businesses Rekoda is built for.',
  },
  {
    question: 'Does Rekoda hold my money?',
    answer:
      'No. Payments go to your own Paystack account and settle to your own bank account. Rekoda only reads what happened so it can build your records — it is never a step the money passes through.',
  },
  {
    question: 'How does Rekoda know a payment is real?',
    answer:
      'It checks with your payment provider rather than trusting a screenshot. If the money has not arrived, Rekoda says so plainly instead of guessing, so you can decide whether to release the goods.',
  },
  {
    question: 'Do I need to install anything?',
    answer:
      'No. Rekoda works inside WhatsApp, on the phone you already use. There is no app to download and no password to remember — you sign in with a code sent to your number.',
  },
  {
    question: 'What does it cost?',
    answer:
      'Plans start at ₦9,900 per month after a 30-day free trial that needs no card. Your payment provider’s processing fees are charged by them, not by Rekoda, and are always shown separately.',
  },
] as const;

export default function HomePage() {
  return (
    <>
      <StructuredData data={softwareApplicationSchema} />
      <StructuredData data={faqSchema(FAQS)} />

      <section className="rk-hero rk-container">
        <h1>You run the business. Rekoda builds the records.</h1>
        <p className="rk-lede">
          Tell Rekoda what happened, or let your shop tell it. You get real invoices, real receipts,
          and books that show whether the money actually arrived.
        </p>
        <div className="rk-cta-row">
          <Button href="/start">Start free for 30 days</Button>
          <Button href="/pricing" variant="secondary">
            See pricing
          </Button>
        </div>

        <div className="rk-grid rk-phone">
          <div className="rk-bubble rk-bubble-out">Ada bought 3 wigs for 150k. She paid 100k.</div>
          <div className="rk-bubble rk-bubble-in">
            Got it — record this?
            <dl>
              <dt>Sale</dt>
              <dd>
                <Money kobo={demo.totalK} />
              </dd>
              <dt>Paid</dt>
              <dd>
                <Money kobo={demo.amountPaidK} />
              </dd>
              <dt>Outstanding</dt>
              <dd>
                <Money kobo={demo.balanceDueK} />
              </dd>
            </dl>
          </div>
          <div className="rk-bubble rk-bubble-in">
            Done. Invoice and receipt created.
            <p className="rk-bubble-badge">
              <MoneyBadge state="recorded" />
            </p>
          </div>
        </div>
      </section>

      <section className="rk-section rk-container">
        <h2>Know when the money really landed</h2>
        <p>
          A customer shows you an alert. Did the money actually arrive? Rekoda answers that — and
          the answer you need most is the one that says <strong>no</strong>.
        </p>
        <div className="rk-grid rk-grid-3">
          <article className="rk-card rk-card-badged">
            <h3>Verified</h3>
            <p>Your bank confirmed the money arrived. Safe to hand over the goods.</p>
            <MoneyBadge state="verified" />
          </article>
          <article className="rk-card rk-card-badged">
            <h3>Recorded</h3>
            <p>
              You told Rekoda about it — a cash sale, or a transfer we do not watch. Perfectly
              normal, and kept in your books.
            </p>
            <MoneyBadge state="recorded" />
          </article>
          <article className="rk-card rk-card-badged">
            <h3>Not seen yet</h3>
            <p>
              We have not seen this money. Usually it is still on its way — but do not release goods
              on a screenshot.
            </p>
            <MoneyBadge state="notSeen" />
          </article>
        </div>
      </section>

      <section className="rk-section rk-container">
        <h2>Books your accountant recognises</h2>
        <p>
          Not just a list of sales. Every message becomes a double-entry record, so what comes out
          is what an accountant already knows how to read.
        </p>
        <ul className="rk-check-list">
          <li>Profit &amp; loss, balance sheet and cash flow</li>
          <li>A trial balance that has to balance, and does</li>
          <li>Invoices and receipts numbered in an unbroken sequence</li>
          <li>Every figure traceable back to the message that created it</li>
        </ul>
      </section>

      <section className="rk-section rk-container">
        <h2>Questions merchants ask</h2>
        <div className="rk-faq">
          {FAQS.map((faq) => (
            <details key={faq.question} className="rk-faq-item">
              <summary>{faq.question}</summary>
              <p>{faq.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="rk-section rk-container rk-closer">
        <h2>Start with one message</h2>
        <p>
          Thirty days free, no card. If Rekoda is not keeping better books than you are today, walk
          away and take your records with you.
        </p>
        <div className="rk-cta-row">
          <Button href="/start">Start free for 30 days</Button>
        </div>
      </section>
    </>
  );
}
