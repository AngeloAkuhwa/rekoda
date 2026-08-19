import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

/**
 * Crawler policy (MASTER-PLAN §5.2.5).
 *
 * The disallow list is the important half. Everything behind `/app`,
 * `/setup` and `/verify` is either a merchant's own records or a step in a
 * signup flow — indexing any of it would put a business's name, and the shape
 * of its onboarding, into search results. `robots.txt` is a request rather
 * than an access control, which is why those routes ALSO carry
 * `robots: { index: false }` in their metadata and a server-side guard. This
 * is the outermost of three layers, not the only one.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/app', '/setup/', '/verify', '/start'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
