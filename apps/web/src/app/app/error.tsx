'use client';

import Link from 'next/link';

/**
 * The dashboard's own boundary, one level under the root one.
 *
 * Five widgets share a page here, and before this existed any ONE of them
 * throwing took the navigation down with it: the merchant lost the whole
 * dashboard to a single failed read. The books are still there; this page's
 * job is to say so and keep the doors visible.
 */
export default function DashboardError({ reset }: { error: Error; reset: () => void }) {
  return (
    <section className="rk-container rk-dash">
      <div className="rk-card" style={{ marginTop: '4rem', textAlign: 'center' }}>
        <h1>This page did not load</h1>
        <p>
          One of the numbers on this page could not be fetched. Your records are safe and nothing
          was lost.
        </p>
        <p>
          <button type="button" className="rk-review-btn" onClick={() => reset()}>
            Try again
          </button>
        </p>
        <p className="rk-fineprint">
          <Link href="/app">Back to the overview</Link>
        </p>
      </div>
    </section>
  );
}
