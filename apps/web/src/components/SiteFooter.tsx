'use client';

import { usePathname } from 'next/navigation';

/**
 * The legal links stay everywhere — they are the ones a merchant is most
 * likely to want exactly when they are logged in and wondering what we hold.
 * The marketing sentence does not: on the dashboard it is a pitch to someone
 * who has already bought.
 */
export function SiteFooter() {
  const pathname = usePathname() ?? '/';
  const inProduct = pathname.startsWith('/app') || pathname.startsWith('/setup');

  return (
    <footer className="rk-footer">
      <div className="rk-container">
        {inProduct ? null : (
          <p>
            Rekoda keeps your records. Payments run through your own Paystack account, and Rekoda
            never holds your money.
          </p>
        )}
        <nav aria-label="Legal">
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="/security">Security</a>
          <a href="/ai-privacy">AI &amp; privacy</a>
          <a href="/refunds">Refunds</a>
          <a href="/data-deletion">Delete my data</a>
        </nav>
      </div>
    </footer>
  );
}
