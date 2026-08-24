import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { publicShop } from '@/server/api';
import { CheckoutForm } from './CheckoutForm';

/**
 * The shop's checkout (fix-plan 6, M5b): the cart this browser built, a
 * name, a phone number, and one button.
 *
 * Server-rendered only as far as knowing the shop is real; everything the
 * page shows comes out of localStorage after mount, because the server has
 * never seen this cart and never will until the order is placed.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const shop = await publicShop((await params).slug);
  if (!shop) return { title: 'Shop not found', robots: { index: false, follow: false } };
  return {
    title: { absolute: `Your order · ${shop.displayName}` },
    /* The shop page is indexable; a checkout is nobody's search result. */
    robots: { index: false, follow: false },
  };
}

export default async function CheckoutPage({ params }: { params: Promise<{ slug: string }> }) {
  const shop = await publicShop((await params).slug);
  if (!shop) notFound();

  return (
    <section className="rk-container rk-shop rk-checkout">
      <header className="rk-shop-head">
        <h1>Your order</h1>
        <p className="rk-fineprint">
          From{' '}
          <a href={`/s/${shop.slug}`} className="rk-checkout-back">
            {shop.displayName}
          </a>
          . Nothing is paid here; {shop.displayName} confirms your order on WhatsApp and tells you
          how to pay.
        </p>
      </header>
      <CheckoutForm
        slug={shop.slug}
        displayName={shop.displayName}
        whatsappE164={shop.whatsappE164}
      />
    </section>
  );
}
