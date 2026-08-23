/**
 * The overview waits on several reads at once, and with no fallback the
 * whole route blocked on the slowest of them behind a blank screen. This is
 * deliberately quiet: a spinner that looks like the page it precedes.
 */
export default function DashboardLoading() {
  return (
    <section className="rk-container rk-dash" aria-busy="true">
      <div className="rk-card" style={{ marginTop: '4rem', textAlign: 'center' }}>
        <p className="rk-fineprint">Loading your records…</p>
      </div>
    </section>
  );
}
