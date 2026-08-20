/**
 * Security headers, and why each one is here.
 *
 * The app had none of these. For a product whose whole promise is "these
 * records are trustworthy", a missing `Content-Security-Policy` is not a
 * checklist item — it is the difference between an injected script being inert
 * and it being able to read a merchant's session-bound pages.
 */

/**
 * Why `script-src` allows inline scripts.
 *
 * Hashing the inline no-flash theme script does not work here: browsers
 * IGNORE `'unsafe-inline'` as soon as a hash is present, so Next's own
 * streaming-SSR bootstrap scripts get refused, hydration dies with React
 * error #412, and every form silently stops working while pages still render.
 * A CSP that breaks the product is not a security control.
 *
 * Those bootstrap scripts cannot be hashed — their content varies per page and
 * per build. The only strict alternative is a per-request nonce, which forces
 * every page out of static rendering; that trade is worth revisiting once the
 * marketing pages sit behind a CDN, and is NOT worth making blind.
 *
 * What this policy still buys, which is most of the value: no third-party
 * script origin can load, `object-src` and `base-uri` are closed, the site
 * cannot be framed, and form posts cannot be redirected off-origin.
 */
const isProduction = process.env.NODE_ENV === 'production';

const csp = [
  "default-src 'self'",
  // Next injects inline bootstrap scripts; 'unsafe-inline' is ignored by
  // browsers that honour hashes, so it is only a fallback for older ones.
  `script-src 'self' 'unsafe-inline'${isProduction ? '' : " 'unsafe-eval'"}`,
  // Next emits inline <style> for CSS modules; no third-party stylesheet now.
  "style-src 'self' 'unsafe-inline'",
  // Fonts are self-hosted, so this closes to our own origin entirely.
  "font-src 'self'",
  "img-src 'self' data:",
  // The browser only ever talks to this origin — every API call is made
  // server-side, so there is no third-party host to allow here.
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  // Rekoda is never legitimately framed. This is the modern X-Frame-Options.
  "frame-ancestors 'none'",
  "object-src 'none'",
  ...(isProduction ? ['upgrade-insecure-requests'] : []),
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  // Two years, subdomains included. Only meaningful over HTTPS, and only set
  // in production so local http:// development is not poisoned for months.
  ...(isProduction
    ? [
        {
          key: 'Strict-Transport-Security',
          value: 'max-age=63072000; includeSubDomains; preload',
        },
      ]
    : []),
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Full URLs of a merchant's pages must not travel to third parties; the
  // origin alone is enough for analytics.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  // Nothing here needs a camera, a microphone or a location.
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@rekoda/core'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
