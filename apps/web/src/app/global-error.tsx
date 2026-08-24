'use client';

/**
 * The boundary of last resort: a throw in the root layout itself.
 *
 * Next's default here is an unstyled stack-trace page. This one keeps the
 * promise the other error boundaries make: plain words, no blame, and the
 * fact that matters most in a bookkeeping product stated outright. It must
 * render its own <html> and <body> because the layout that normally provides
 * them is the thing that failed.
 */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          display: 'grid',
          placeItems: 'center',
          minHeight: '100vh',
          margin: 0,
          padding: '2rem',
          textAlign: 'center',
        }}
      >
        <div>
          <h1 style={{ marginBottom: '0.5rem' }}>Something broke on our side</h1>
          <p style={{ maxWidth: '38rem' }}>
            Your records are safe: nothing you recorded is affected by a page failing to draw. Try
            again, and if this keeps happening, message Rekoda on WhatsApp.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{ padding: '0.6rem 1.2rem', cursor: 'pointer' }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
