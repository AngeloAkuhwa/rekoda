import type { MetadataRoute } from 'next';
import { MARKETING_ROUTES, SITE_URL } from '@/lib/site';
import { publicShopIndex } from '@/server/api';

/**
 * The marketing surface, plus every shop a merchant has opened.
 *
 * The marketing half is derived from `MARKETING_ROUTES` rather than listed
 * here, so a new private route cannot join the sitemap by somebody forgetting
 * to exclude it. Onboarding steps and the dashboard are absent by
 * construction, which is the point: a sitemap is an invitation to index.
 *
 * Shops are the one merchant-specific thing that belongs. `/s/<handle>` is
 * already indexable and already declares itself canonical, so this changes
 * nothing about what is public; it only stops discovery depending entirely on
 * a merchant remembering to share the link. The shop settings form says so in
 * as many words, because "open the shop" should not quietly mean something
 * more than a merchant read.
 *
 * Nothing but slugs and dates crosses from the API. A list of merchants
 * carrying their names and numbers would be a directory, and a directory is
 * not what anybody asked us to publish.
 */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const lastModified = new Date();
  const marketing = MARKETING_ROUTES.map((route) => ({
    url: `${SITE_URL}${route.path}`,
    lastModified,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));

  /**
   * An unreachable API costs the shops, never the file.
   *
   * A sitemap that 500s is worse than one that is short: a crawler that gets
   * an error stops asking for a while, and the marketing pages lose their
   * listing too. Degrading to the half we can always produce is the honest
   * failure, and the next revalidation picks the shops back up.
   */
  const index = await publicShopIndex().catch(() => null);
  if (!index) return marketing;

  const shops = index.shops.map((shop) => ({
    url: `${SITE_URL}/s/${shop.slug}`,
    lastModified: new Date(shop.updatedAt),
    /* Weekly, and below every marketing page. A shop changes when its owner
     * changes it, which is neither daily nor never, and priority here is a
     * hint about relative importance WITHIN this site rather than a ranking
     * claim about anybody's shop. */
    changeFrequency: 'weekly' as const,
    priority: 0.6,
  }));

  return [...marketing, ...shops];
}
