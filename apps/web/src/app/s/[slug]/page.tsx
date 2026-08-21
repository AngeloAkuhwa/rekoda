import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { formatKobo } from '@rekoda/core';
import { publicShop } from '@/server/api';

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
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const shop = await publicShop((await params).slug);
  if (!shop) return { title: 'Shop not found', robots: { index: false, follow: false } };
  return {
    title: shop.displayName,
    description: shop.tagline ?? `What ${shop.displayName} sells, and how to order.`,
    /* Indexable, unlike every dashboard page. A shop nobody can find is a
     * shop, and being findable is the point of publishing one. */
    robots: { index: true, follow: true },
  };
}

export default async function ShopPage({ params }: { params: Promise<{ slug: string }> }) {
  const shop = await publicShop((await params).slug);
  if (!shop) notFound();

  return (
    <section className="rk-container rk-shop">
      <header className="rk-shop-head">
        <h1>{shop.displayName}</h1>
        {shop.tagline ? <p className="rk-shop-tagline">{shop.tagline}</p> : null}
        <p className="rk-fineprint">
          Tap any item to message {shop.displayName} on WhatsApp with your order already written.
        </p>
      </header>

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
              <a className="rk-btn rk-shop-ask" href={orderLink(shop.whatsappE164, product.name)}>
                Order on WhatsApp
              </a>
            </div>
          </li>
        ))}
      </ul>

      <footer className="rk-shop-foot">
        <p className="rk-fineprint">
          Prices are what {shop.displayName} charges today and may change. Ordering happens on
          WhatsApp, directly with them.
        </p>
      </footer>
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
function orderLink(whatsappE164: string, product: string): string {
  const number = whatsappE164.replace(/[^0-9]/g, '');
  const text = encodeURIComponent(`Hello, I want to order: ${product}`);
  return `https://wa.me/${number}?text=${text}`;
}
