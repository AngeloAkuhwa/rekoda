/**
 * One source of truth for the public surface.
 *
 * `robots.ts`, `sitemap.ts` and every page's canonical URL read from here, so
 * they cannot disagree about which routes are public — the failure mode being
 * a private route that is excluded from robots.txt but still listed in the
 * sitemap, which is an invitation to index it.
 */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://rekoda.app').replace(
  /\/$/,
  '',
);

export interface MarketingRoute {
  path: string;
  changeFrequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  priority: number;
}

/** Public, indexable pages. Nothing merchant-specific may be added here. */
export const MARKETING_ROUTES: MarketingRoute[] = [
  { path: '/', changeFrequency: 'weekly', priority: 1 },
  { path: '/pricing', changeFrequency: 'weekly', priority: 0.9 },
  { path: '/security', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/ai-privacy', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/privacy', changeFrequency: 'yearly', priority: 0.4 },
  { path: '/terms', changeFrequency: 'yearly', priority: 0.4 },
  { path: '/refunds', changeFrequency: 'yearly', priority: 0.4 },
  { path: '/data-deletion', changeFrequency: 'yearly', priority: 0.4 },
];

/** Absolute canonical URL for a path — relative canonicals are ambiguous. */
export const canonical = (path: string): string => `${SITE_URL}${path}`;
