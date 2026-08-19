import type { Metadata } from 'next';
import '../styles/globals.css';
import { ThemeToggle } from '@/components/ThemeToggle';

export const metadata: Metadata = {
  metadataBase: new URL('https://rekoda.app'),
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

function SiteHeader() {
  return (
    <header className="rk-header">
      <div className="rk-container rk-header-inner">
        <a href="/" className="rk-wordmark">
          Rekoda
        </a>
        <nav aria-label="Main">
          <a href="/pricing">Pricing</a>
          <a href="/security">Security</a>
        </nav>
        <ThemeToggle />
      </div>
    </header>
  );
}

function SiteFooter() {
  return (
    <footer className="rk-footer">
      <div className="rk-container">
        <p>
          Rekoda keeps your records. Payments are processed by your own Paystack account — Rekoda
          never holds your money.
        </p>
        <nav aria-label="Legal">
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="/ai-privacy">AI &amp; privacy</a>
          <a href="/data-deletion">Delete my data</a>
        </nav>
      </div>
    </footer>
  );
}
