import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { formatKobo } from '@rekoda/core';
import { canonical } from '@/lib/site';
import { publicShop } from '@/server/api';
import { AddToCart, CartBar } from './CartControls';

/**
 * A merchant's shop, open to anybody (MASTER-PLAN §5.3.5, "Door 1").
 *
 * The first page in Rekoda with no session behind it. Nothing on it is read
 * from a cookie and nothing on it can be, which is why the whole route takes
 * one input: the slug in the URL.
 *
 * ── the button is the product ──────────────────────────────────────────────
 *
 * There is no cart and no checkout, and that is the design rather than a
 * missing half. A Nigerian customer who finds a shop does not want an account
 * and a password; they want to message the seller. So every product carries a
 * WhatsApp link with the order already written, and the merchant forwards
 * that message to Rekoda, which prices it from this same catalogue and offers
 * the invoice. Door 1 hands to Door 2, and the customer only ever used an app
 * they already had open.
 */
export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string }>;
}): Promise<Metadata> {
  const slug = (await params).slug;
  const page = pageFrom((await searchParams).page);
  const shop = await publicShop(slug, page);
  if (!shop) return { title: 'Shop not found', robots: { index: false, follow: false } };
  const description = shop.tagline ?? `What ${shop.displayName} sells, and how to order.`;
  return {
    /* Absolute, so the layout's "%s · Rekoda" template does not apply. A
     * merchant's shop is not a Rekoda page with their name on it; putting our
     * brand in their tab and in their search result is the same mistake the
     * header made by carrying our pricing link onto their storefront. */
    title: { absolute: shop.displayName },
    description,
    /* Indexable, unlike every dashboard page. A shop nobody can find is a
     * shop, and being findable is the point of publishing one. */
    robots: { index: true, follow: true },
    /* Its own, not the homepage's. Every page inherits the layout's canonical
     * of "/", and a shop that declares the homepage as its canonical is a shop
     * telling Google not to index it: exactly the opposite of the line above,
     * and silently, since the page still renders perfectly. */
    /* Each page its own canonical. Page two declaring page one canonical is
     * page two telling Google its products do not exist. */
    alternates: { canonical: canonical(page > 1 ? `/s/${slug}?page=${page}` : `/s/${slug}`) },
    /* The shop's own name in the card, not Rekoda's. `opengraph-image.tsx`
     * beside this file draws it; this is what the words around it say. */
    openGraph: {
      type: 'website',
      title: shop.displayName,
      description,
      siteName: shop.displayName,
    },
    twitter: { card: 'summary_large_image', title: shop.displayName, description },
  };
}

/** Anything unparseable is page one: a mangled shared link should still open the shop. */
function pageFrom(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '1', 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

export default async function ShopPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const page = pageFrom((await searchParams).page);
  const shop = await publicShop((await params).slug, page);
  if (!shop) notFound();

  return (
    <section className="rk-container rk-shop">
      <header className="rk-shop-head">
        <h1>{shop.displayName}</h1>
        {shop.tagline ? <p className="rk-shop-tagline">{shop.tagline}</p> : null}
        <p className="rk-fineprint">
          Add items and order right here, or tap any item to message {shop.displayName} on WhatsApp
          with your order already written.
        </p>
      </header>

      {shop.products.length === 0 ? (
        /* A published shop can empty out later: everything hidden, or every
           price removed. The API refuses to PUBLISH an empty shop, but it
           cannot stop one becoming empty, and "Tap any item" above nothing
           reads as a broken page to the one audience that never saw a
           dashboard. */
        <p className="rk-fineprint">
          {shop.displayName} is not listing anything right now. Message them on{' '}
          <a href={`https://wa.me/${shop.whatsappE164.replace(/[^0-9]/g, '')}`}>WhatsApp</a> to ask
          what is available.
        </p>
      ) : null}

      <ul className="rk-shop-grid">
        {shop.products.map((product) => (
          <li key={product.id} className="rk-shop-item">
            {/* No photo means no box. A square of grey per unphotographed
                product is a screen of nothing to scroll past on a phone, and
                a shop where nobody has added pictures yet reads better as a
                compact list than as a gallery of blanks. */}
            {product.imagePath ? (
              /* Our own route, not the API's. `imagePath` says THAT there is a
                 photo; where a browser can fetch it from is this tier's
                 business, because an `<img>` asks the origin it is on. See
                 app/s/[slug]/photo/[id]. */
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={`/s/${shop.slug}/photo/${product.id}`}
                alt={product.name}
                className="rk-shop-photo"
                loading="lazy"
              />
            ) : null}
            <div className="rk-shop-body">
              <h2>{product.name}</h2>
              {product.description ? <p>{product.description}</p> : null}
              <p className="rk-shop-price">{formatKobo(product.priceK)}</p>
              <div className="rk-shop-actions">
                <AddToCart
                  slug={shop.slug}
                  productId={product.id}
                  name={product.name}
                  priceK={product.priceK}
                />
                <a
                  className="rk-btn rk-shop-ask"
                  href={orderLink(shop.whatsappE164, product.name, product.priceK)}
                >
                  Order on WhatsApp
                </a>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {/* Plain links, no client code: a customer pages a shop the way they
          page anything else, and a crawler follows the same links. Rendered
          only when there is somewhere to go, so most shops never see it. */}
      {shop.pageCount > 1 ? (
        <nav className="rk-shop-pager" aria-label="Shop pages">
          {shop.page > 1 ? (
            <a
              className="rk-btn"
              href={shop.page === 2 ? `/s/${shop.slug}` : `/s/${shop.slug}?page=${shop.page - 1}`}
            >
              Newer items
            </a>
          ) : null}
          <span className="rk-fineprint">
            Page {shop.page} of {shop.pageCount} · {shop.productsTotal} items
          </span>
          {shop.page < shop.pageCount ? (
            <a className="rk-btn" href={`/s/${shop.slug}?page=${shop.page + 1}`}>
              More items
            </a>
          ) : null}
        </nav>
      ) : null}

      <footer className="rk-shop-foot">
        <p className="rk-fineprint">
          Prices are what {shop.displayName} charges today and may change. Order here or on
          WhatsApp, directly with them.
        </p>
      </footer>

      <CartBar slug={shop.slug} />
    </section>
  );
}

/**
 * A wa.me link with the order already typed.
 *
 * The number loses its plus, which is what wa.me expects, and the message is
 * encoded whole. One item per link rather than a basket, because a customer
 * who wants two things sends two messages or edits one, and a basket would be
 * a cart by another name with none of a cart's guarantees.
 */
function orderLink(whatsappE164: string, product: string, priceK: number): string {
  const number = whatsappE164.replace(/[^0-9]/g, '');
  /* The price rides along and the quantity is asked for in the message
   * itself: the merchant's order pipeline prices by name, and a message that
   * already says "2x" is an order nobody has to come back and ask about. */
  const text = encodeURIComponent(
    `Hello, I want to order: ${product} (${formatKobo(priceK)} each). How many: `,
  );
  return `https://wa.me/${number}?text=${text}`;
}
