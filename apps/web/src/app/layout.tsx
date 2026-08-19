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
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Calistoga&family=Inter:wght@400;500;600&family=Noto+Sans:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
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
