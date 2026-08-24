'use client';

import { useEffect, useState } from 'react';
import { formatKobo } from '@rekoda/core';
import { addToCart, CART_EVENT, cartCount, cartTotalK, readCart } from '@/lib/cart';

/**
 * The two client islands on an otherwise server-rendered shop (fix-plan 6,
 * M5b). Everything else on the page stays static and crawlable; these hold
 * the only state the page has, and that state lives in the browser.
 */

/** One product's way into the cart. Sits beside the WhatsApp button rather
 * than replacing it: a customer who wants to talk still talks. */
export function AddToCart({
  slug,
  productId,
  name,
  priceK,
}: {
  slug: string;
  productId: string;
  name: string;
  priceK: number;
}) {
  const [added, setAdded] = useState(false);
  return (
    <button
      type="button"
      className="rk-btn rk-shop-add"
      onClick={() => {
        addToCart(slug, { productId, name, priceK });
        setAdded(true);
        window.setTimeout(() => setAdded(false), 1500);
      }}
    >
      {added ? 'Added' : 'Add to order'}
    </button>
  );
}

/**
 * The running order, pinned to the bottom of the shop once it has anything
 * in it. Rendered empty on the server and filled after mount, because the
 * server cannot know what this browser's cart holds; until then it simply
 * is not there, which is also what a customer with storage disabled sees.
 */
export function CartBar({ slug }: { slug: string }) {
  const [summary, setSummary] = useState<{ count: number; totalK: number } | null>(null);

  useEffect(() => {
    const refresh = () => {
      const cart = readCart(slug);
      setSummary({ count: cartCount(cart), totalK: cartTotalK(cart) });
    };
    refresh();
    window.addEventListener(CART_EVENT, refresh);
    return () => window.removeEventListener(CART_EVENT, refresh);
  }, [slug]);

  if (!summary || summary.count === 0) return null;
  return (
    <div className="rk-cart-bar">
      <span>
        {summary.count} {summary.count === 1 ? 'item' : 'items'} · {formatKobo(summary.totalK)}
      </span>
      <a className="rk-btn rk-cart-bar-go" href={`/s/${slug}/checkout`}>
        Review and order
      </a>
    </div>
  );
}
