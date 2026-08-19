'use client';

import { usePathname } from 'next/navigation';
import { ThemeToggle } from '@/components/ThemeToggle';

/** Routes where the header should get out of the merchant's way. */
const FOCUSED = ['/start', '/verify', '/setup'];
const APP = '/app';

/**
 * A header that knows where it is.
 *
 * Marketing navigation followed the merchant into signup and onto the
 * dashboard, which is wrong in both places for different reasons. During
 * onboarding it is an exit ramp from a flow the merchant is 90 seconds from
 * finishing; on the dashboard it is someone else's furniture in your office.
 *
 * The wordmark stops being a link during onboarding too — mid-flow, "Rekoda"
 * looks like a home button and taking it abandons the signup.
 */
export function SiteHeader() {
  const pathname = usePathname() ?? '/';
  const focused = FOCUSED.some((p) => pathname.startsWith(p));
  const inApp = pathname.startsWith(APP);

  return (
    <header className="rk-header">
      <div className="rk-container rk-header-inner">
        {focused ? (
          <span className="rk-wordmark" aria-label="Rekoda">
            Rekoda
          </span>
        ) : (
          <a href={inApp ? APP : '/'} className="rk-wordmark">
            Rekoda
          </a>
        )}

        {focused || inApp ? (
          <span className="rk-header-spacer" />
        ) : (
          <nav aria-label="Main">
            <a href="/pricing">Pricing</a>
            <a href="/security">Security</a>
          </nav>
        )}

        <ThemeToggle />
      </div>
    </header>
  );
}
