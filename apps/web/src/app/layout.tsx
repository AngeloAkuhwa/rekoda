import type { Metadata } from 'next';
import '../styles/globals.css';
import { SITE_URL } from '@/lib/site';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  // Every page inherits a canonical; pages that live at a different path
  // override it. Without this a crawler treats ?utm_source=… as a separate
  // page and splits the ranking of the one it should have.
  alternates: { canonical: '/' },
  title: {
    default: 'Rekoda — You run the business. Rekoda builds the records.',
    template: '%s · Rekoda',
  },
  description:
    'Rekoda turns what happens in your business into real financial records — invoices, receipts, and books you can trust. Works on WhatsApp.',
  openGraph: {
    type: 'website',
    locale: 'en_NG',
    siteName: 'Rekoda',
  },
  robots: { index: true, follow: true },
};

/**
 * No-flash theme script. Runs before paint so a dark-mode user never sees a
 * white flash — and so `data-theme` wins over the system preference in both
 * directions (MASTER.md §2).
 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('rk-theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-NG">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/*
          Self-hosted (scripts/fetch-fonts.mjs). This used to be a stylesheet
          link to fonts.googleapis.com, which blocks the first paint behind a
          DNS lookup, a TLS handshake and two round trips to a third party —
          on exactly the slow mobile networks Rekoda's merchants are on.

          Only the two faces above the fold are preloaded. Preloading all
          twelve would compete with the HTML for the same scarce bandwidth and
          make the problem worse; the rest arrive through the stylesheet, and
          `unicode-range` means a browser never fetches a subset it has no
          glyphs for.
        */}
        <link
          rel="preload"
          href="/fonts/inter-400-latin.woff2"
          as="font"
          type="font/woff2"
          crossOrigin=""
        />
        <link
          rel="preload"
          href="/fonts/calistoga-400-latin.woff2"
          as="font"
          type="font/woff2"
          crossOrigin=""
        />
        <link rel="stylesheet" href="/fonts/fonts.css" />
      </head>
      <body>
        <a href="#main" className="rk-sr-only">
          Skip to content
        </a>
        <SiteHeader />
        <main id="main">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
