import type { MetadataRoute } from 'next';
import { MARKETING_ROUTES, SITE_URL } from '@/lib/site';

/**
 * Only the public marketing surface belongs here.
 *
 * A sitemap is an invitation to index, so onboarding steps, the dashboard and
 * anything merchant-specific are absent by construction: the list is derived
 * from `MARKETING_ROUTES`, so a new private route cannot be added to the
 * sitemap by forgetting to exclude it.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return MARKETING_ROUTES.map((route) => ({
    url: `${SITE_URL}${route.path}`,
    lastModified,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
