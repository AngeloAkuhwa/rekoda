/**
 * The shop a customer can open, and the only path in this package that reads
 * across tenants without a session (MASTER-PLAN §5.3.5).
 *
 * `shops` holds nothing a merchant has not published, which is what makes a
 * public read of it safe. Resolving a slug to a business is deliberately the
 * ONLY cross-tenant step: once the tenant is known, everything else the shop
 * page shows is read under an ordinary pin, so the blast radius of a slug
 * somebody typed is exactly the catalogue that slug's owner chose to list.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';
import { shops } from '../schema/commerce.js';

/** Lowercase, digits, single hyphens. The CHECK in migration 0030, in code. */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isShopSlug(value: string): boolean {
  return SLUG.test(value) && value.length >= 3 && value.length <= 40;
}

/**
 * A slug, from a name a merchant already typed.
 *
 * A suggestion, never a decision: the merchant can change it, and it is their
 * public handle. Accents and punctuation go, spaces become hyphens, and what
 * is left is what a customer could read off a shop sign and type.
 */
export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base.length >= 3 ? base : '';
}

export interface PublicShop {
  businessId: string;
  slug: string;
  displayName: string;
  whatsappE164: string;
  tagline: string | null;
}

/**
 * The one cross-tenant read, and the whole reason `shops` is its own table.
 *
 * Takes the plain `Db` rather than a pinned transaction because there is no
 * tenant yet: the slug IS the question. Only PUBLISHED shops answer, so a
 * reserved name is not a way to discover that a business exists.
 */
export async function shopBySlug(db: Db, slug: string): Promise<PublicShop | null> {
  if (!isShopSlug(slug)) return null;
  const rows = await db
    .select({
      businessId: shops.businessId,
      slug: shops.slug,
      displayName: shops.displayName,
      whatsappE164: shops.whatsappE164,
      tagline: shops.tagline,
    })
    .from(shops)
    .where(and(eq(shops.slug, slug), isNotNull(shops.publishedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export interface ShopIndexEntry {
  slug: string;
  /** When the shop itself last changed. Not when its catalogue did. */
  updatedAt: Date;
}

/**
 * Every open shop, for the sitemap.
 *
 * The second cross-tenant read, and the one that needs its limits saying out
 * loud. It returns SLUGS AND DATES and nothing else: not the business, not
 * the display name, not the WhatsApp number. A sitemap needs a URL and a
 * date, and a list of merchants with their phone numbers attached is a
 * different thing entirely from a list of pages.
 *
 * Ordered by slug rather than by date so the file is stable between builds:
 * a sitemap that reshuffles on every fetch teaches a crawler that the whole
 * site changed when nothing did.
 *
 * `limit` is the caller's, and the caller is expected to notice when it is
 * reached. A sitemap silently truncated at its cap reads exactly like a
 * complete one, which is the failure mode worth being loud about.
 */
export async function publishedShops(db: Db, limit: number): Promise<ShopIndexEntry[]> {
  const rows = await db
    .select({ slug: shops.slug, updatedAt: shops.updatedAt })
    .from(shops)
    .where(isNotNull(shops.publishedAt))
    .orderBy(shops.slug)
    .limit(limit);
  return rows.map((row) => ({ slug: row.slug, updatedAt: row.updatedAt }));
}

export interface ShopSettings {
  slug: string;
  displayName: string;
  whatsappE164: string;
  tagline: string | null;
  publishedAt: Date | null;
}

/** The merchant's own view of their shop, pinned. Null before they make one. */
export async function shopFor(tx: TenantDb, businessId: string): Promise<ShopSettings | null> {
  const rows = await tx
    .select({
      slug: shops.slug,
      displayName: shops.displayName,
      whatsappE164: shops.whatsappE164,
      tagline: shops.tagline,
      publishedAt: shops.publishedAt,
    })
    .from(shops)
    .where(eq(shops.businessId, businessId))
    .limit(1);
  return rows[0] ?? null;
}

export interface SaveShopInput {
  businessId: string;
  slug: string;
  displayName: string;
  whatsappE164: string;
  tagline: string | null;
  published: boolean;
}

export type SaveOutcome = 'saved' | 'bad_slug';

/**
 * Somebody else already has that handle.
 *
 * THROWN rather than returned, and the distinction is not stylistic. A unique
 * violation aborts the PostgreSQL transaction it happened in: catching it and
 * returning an outcome would leave the caller inside a transaction that can
 * no longer commit, and the error would resurface at the commit instead, from
 * somewhere that has lost all the context. So it unwinds, exactly like
 * `TokenCollision` does, and the caller outside the transaction turns it into
 * a sentence.
 */
export class SlugTaken extends Error {
  override readonly name = 'SlugTaken';
}

/**
 * Create or update the shop, and publish or unpublish it in the same write.
 *
 * The unique index decides whether a handle is free, not a read before the
 * write: two merchants can both find a name available and only one of them
 * can have it.
 */
export async function saveShop(tx: TenantDb, input: SaveShopInput): Promise<SaveOutcome> {
  if (!isShopSlug(input.slug)) return 'bad_slug';

  const values = {
    businessId: input.businessId,
    slug: input.slug,
    displayName: input.displayName,
    whatsappE164: input.whatsappE164,
    tagline: input.tagline,
    publishedAt: input.published ? new Date() : null,
    updatedAt: new Date(),
  };

  try {
    await tx
      .insert(shops)
      .values(values)
      .onConflictDoUpdate({
        target: shops.businessId,
        set: {
          slug: values.slug,
          displayName: values.displayName,
          whatsappE164: values.whatsappE164,
          tagline: values.tagline,
          /* Publishing again must not move the date. When it first went
           * public is a fact, and re-saving a tagline is not a republication. */
          publishedAt: input.published ? sql`COALESCE(${shops.publishedAt}, now())` : null,
          updatedAt: values.updatedAt,
        },
      });
    return 'saved';
  } catch (error: unknown) {
    if (isSlugCollision(error)) throw new SlugTaken(`the handle ${input.slug} is taken`);
    throw error;
  }
}

/** A unique violation on the slug, and only that one. */
function isSlugCollision(error: unknown): boolean {
  const code = (error as { cause?: { code?: string }; code?: string })?.code;
  const causeCode = (error as { cause?: { code?: string } })?.cause?.code;
  const text = error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : '';
  return (code === '23505' || causeCode === '23505') && text.includes('shops_slug');
}
