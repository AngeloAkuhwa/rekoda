'use client';

/**
 * The last line between an outage and a raw crash screen.
 *
 * Every page load that throws — most likely ApiUnavailable when the API is
 * unreachable — lands here instead of Next's unstyled stack-trace page. The
 * one thing a merchant must hear at that moment: the records are safe, and
 * the outage is ours, not theirs.
 */
export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return (
    <section className="rk-container rk-dash">
      <div className="rk-card" style={{ marginTop: '4rem', textAlign: 'center' }}>
        <h1>We could not load this page</h1>
        <p>
          Rekoda is having trouble reaching its own servers. Your records are safe and nothing was
          lost. This is on us, not you.
        </p>
        <p>
          <button type="button" className="rk-review-btn" onClick={() => reset()}>
            Try again
          </button>
        </p>
      </div>
    </section>
  );
}
