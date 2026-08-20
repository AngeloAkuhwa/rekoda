import Link from 'next/link';

/** A mistyped link gets a branded page with a way back, never a dead end. */
export default function NotFound() {
  return (
    <section className="rk-container rk-dash">
      <div className="rk-card" style={{ marginTop: '4rem', textAlign: 'center' }}>
        <h1>That page does not exist</h1>
        <p>The link may be old or mistyped. Your records are unaffected.</p>
        <p>
          <Link href="/app">Go to your dashboard</Link> · <Link href="/">Rekoda home</Link>
        </p>
      </div>
    </section>
  );
}
