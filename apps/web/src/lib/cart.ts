/**
 * The storefront cart (fix-plan 6, M5b), which lives in the customer's
 * browser and nowhere else.
 *
 * localStorage rather than a server session, because the shop has no
 * sessions and should not grow one for this: a cart is a shortlist, not a
 * record, and nothing in it is trusted anyway. The server reprices every
 * line from the catalogue when the order arrives, so the worst a tampered
 * cart can do is order a real product at its real price.
 *
 * Every read and write is wrapped: localStorage throws in private windows
 * and under some privacy settings, and a shop that crashes for those
 * customers has failed harder than a shop whose cart forgets. When storage
 * is unavailable the cart quietly behaves as empty, and the WhatsApp
 * buttons beside it still work.
 */

export interface CartLine {
  productId: string;
  name: string;
  priceK: number;
  quantity: number;
}

export interface Cart {
  /** Minted with the cart, sent as the order's one-shot key: a resubmitted
   * checkout (double tap, flaky network retry) orders NOTHING twice. */
  ref: string;
  lines: CartLine[];
}

/** The contract's own ceilings, enforced here so a cart that grows past
 * them is stopped at the button rather than refused at the API. */
export const MAX_CART_LINES = 20;
export const MAX_LINE_QUANTITY = 100;

const key = (slug: string) => `rk-cart:${slug}`;

/** Fired on the window after every write, so the cart bar on the shop page
 * can re-count without owning the buttons that changed it. */
export const CART_EVENT = 'rk-cart-changed';

function freshRef(): string {
  try {
    return crypto.randomUUID();
  } catch {
    /* Very old WebViews. Random enough for a dedupe key that also carries a
     * server-side uniqueness constraint. */
    const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}

/** A line as it must look to be worth keeping. Anything else in storage is
 * an old shape or a tampered one, and the safe reading of both is "empty". */
function isLine(value: unknown): value is CartLine {
  const line = value as CartLine;
  return (
    typeof line === 'object' &&
    line !== null &&
    typeof line.productId === 'string' &&
    typeof line.name === 'string' &&
    Number.isInteger(line.priceK) &&
    line.priceK >= 0 &&
    Number.isInteger(line.quantity) &&
    line.quantity >= 1 &&
    line.quantity <= MAX_LINE_QUANTITY
  );
}

export function readCart(slug: string): Cart {
  try {
    const raw = window.localStorage.getItem(key(slug));
    if (!raw) return { ref: freshRef(), lines: [] };
    const parsed = JSON.parse(raw) as { ref?: unknown; lines?: unknown };
    const lines = Array.isArray(parsed.lines)
      ? parsed.lines.filter(isLine).slice(0, MAX_CART_LINES)
      : [];
    const ref = typeof parsed.ref === 'string' && parsed.ref.length >= 8 ? parsed.ref : freshRef();
    return { ref, lines };
  } catch {
    return { ref: freshRef(), lines: [] };
  }
}

function write(slug: string, cart: Cart): void {
  try {
    window.localStorage.setItem(key(slug), JSON.stringify(cart));
  } catch {
    /* Storage refused; the in-memory state the caller holds still renders. */
  }
  try {
    window.dispatchEvent(new Event(CART_EVENT));
  } catch {
    /* An old WebView without Event(): the bar misses one update, no more. */
  }
}

/** Add one of a product, or one more of it. Returns the cart as written. */
export function addToCart(
  slug: string,
  item: { productId: string; name: string; priceK: number },
): Cart {
  const cart = readCart(slug);
  const existing = cart.lines.find((line) => line.productId === item.productId);
  if (existing) {
    existing.quantity = Math.min(existing.quantity + 1, MAX_LINE_QUANTITY);
  } else if (cart.lines.length < MAX_CART_LINES) {
    cart.lines.push({ ...item, quantity: 1 });
  }
  write(slug, cart);
  return cart;
}

/** Set a line's quantity; zero removes it. Returns the cart as written. */
export function setQuantity(slug: string, productId: string, quantity: number): Cart {
  const cart = readCart(slug);
  const capped = Math.min(Math.max(Math.trunc(quantity), 0), MAX_LINE_QUANTITY);
  cart.lines = capped
    ? cart.lines.map((line) =>
        line.productId === productId ? { ...line, quantity: capped } : line,
      )
    : cart.lines.filter((line) => line.productId !== productId);
  write(slug, cart);
  return cart;
}

/** Empty the cart AND retire its ref: the next order is a new order. */
export function clearCart(slug: string): void {
  try {
    window.localStorage.removeItem(key(slug));
  } catch {
    /* Nothing stored is exactly the state we wanted. */
  }
  try {
    window.dispatchEvent(new Event(CART_EVENT));
  } catch {
    /* As above. */
  }
}

export function cartTotalK(cart: Cart): number {
  return cart.lines.reduce((sum, line) => sum + line.priceK * line.quantity, 0);
}

export function cartCount(cart: Cart): number {
  return cart.lines.reduce((sum, line) => sum + line.quantity, 0);
}
