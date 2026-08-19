import { computeMoney } from '@rekoda/core';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { MoneyBadge } from '@/components/ui/MoneyBadge';

/**
 * The hero shows a real conversation, because the product IS a conversation.
 * Every figure below is computed by @rekoda/core at build time — the marketing
 * page cannot drift from the engine, and no number here was typed by hand.
 */
const demo = computeMoney({
  items: [{ name: 'Wig', quantity: 3, price: 50_000 }],
  amountPaid: 100_000,
});

export default function HomePage() {
  return (
    <>
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

        <div className="rk-grid rk-phone" style={{ marginTop: 'var(--rk-space-8)' }}>
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
            <div style={{ marginTop: 'var(--rk-space-3)' }}>
              <MoneyBadge state="recorded" />
            </div>
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
          <article className="rk-card">
            <h3>Verified</h3>
            <p style={{ marginBottom: 'var(--rk-space-3)' }}>
              Your bank confirmed the money arrived. Safe to hand over the goods.
            </p>
            <MoneyBadge state="verified" />
          </article>
          <article className="rk-card">
            <h3>Recorded</h3>
            <p style={{ marginBottom: 'var(--rk-space-3)' }}>
              You told Rekoda about it — a cash sale, or a transfer we do not watch. Perfectly
              normal, and kept in your books.
            </p>
            <MoneyBadge state="recorded" />
          </article>
          <article className="rk-card">
            <h3>Not seen yet</h3>
            <p style={{ marginBottom: 'var(--rk-space-3)' }}>
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
          Not just a list of sales. Profit &amp; loss, balance sheet, cash flow and a trial balance
          — built from every transaction, ready to export.
        </p>
      </section>
    </>
  );
}
