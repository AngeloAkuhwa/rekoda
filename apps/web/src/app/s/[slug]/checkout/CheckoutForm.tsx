'use client';

import { useEffect, useState } from 'react';
import { formatKobo } from '@rekoda/core';
import { Field } from '@/components/ui/Field';
import { cartTotalK, clearCart, readCart, setQuantity, type Cart } from '@/lib/cart';
import { submitStorefrontOrder } from './actions';

/**
 * The whole checkout in one client component (fix-plan 6, M5b), because the
 * cart it renders exists only in this browser.
 *
 * What is deliberately NOT here: prices the server would trust (it reprices
 * every line), an account, a password, and a payment field. The order books
 * itself into the merchant's records the moment it is placed; paying stays a
 * conversation with the merchant, which is where their customers already are.
 * The optional note never leaves this page except inside the customer's own
 * WhatsApp message, so an address given for one delivery is not a record
 * Rekoda keeps.
 */
export function CheckoutForm({
  slug,
  displayName,
  whatsappE164,
}: {
  slug: string;
  displayName: string;
  whatsappE164: string;
}) {
  const [cart, setCart] = useState<Cart | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [shopClosed, setShopClosed] = useState(false);
  const [placed, setPlaced] = useState<
    { orderNumber: string; totalK: number } | 'duplicate' | null
  >(null);

  /* After mount, never during render: the server rendered this component
   * with no cart, and hydration must agree with that before storage is
   * consulted. */
  useEffect(() => {
    setCart(readCart(slug));
  }, [slug]);

  const digits = whatsappE164.replace(/[^0-9]/g, '');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!cart || cart.lines.length === 0 || sending) return;

    const name = customerName.trim();
    const phoneTrimmed = phone.trim();
    if (name.length < 2) {
      setRefusal(`Your name, so ${displayName} knows whose order this is.`);
      return;
    }
    if (phoneTrimmed.replace(/[^0-9]/g, '').length < 7) {
      setRefusal('That phone number does not look complete. Check it and try again.');
      return;
    }

    setSending(true);
    setRefusal(null);
    setShopClosed(false);
    try {
      const outcome = await submitStorefrontOrder(slug, {
        items: cart.lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
        customerName: name,
        customerPhone: phoneTrimmed,
        clientRef: cart.ref,
      });

      if (!outcome) {
        setRefusal('That did not go through. Check your name and phone number and try again.');
        return;
      }
      switch (outcome.outcome) {
        case 'placed':
          clearCart(slug);
          setPlaced({ orderNumber: outcome.orderNumber, totalK: outcome.totalK });
          return;
        case 'duplicate':
          /* The first submission already ordered; this tap changed nothing. */
          clearCart(slug);
          setPlaced('duplicate');
          return;
        case 'items_changed':
          /* The shop moved under the cart. A stale cart resubmitted forever
           * would hit this forever, so it is emptied and rebuilt fresh. */
          clearCart(slug);
          setCart(readCart(slug));
          setRefusal(
            `${displayName} changed their shop since you picked these items. Go back and build your order again.`,
          );
          return;
        case 'bad_phone':
          setRefusal('That phone number does not look complete. Check it and try again.');
          return;
        case 'shop_gone':
          setRefusal('This shop has gone offline. Nothing was ordered.');
          return;
        case 'closed':
          setShopClosed(true);
          setRefusal(`${displayName} is not taking website orders right now.`);
          return;
      }
    } catch {
      setRefusal('That did not go through. Check your connection and try again.');
    } finally {
      setSending(false);
    }
  }

  if (placed) {
    const handoff =
      placed === 'duplicate'
        ? `Hello ${displayName}, I am ${customerName.trim() || 'a customer'}, checking on the order I just placed on your shop.`
        : `Hello ${displayName}, I just placed order ${placed.orderNumber} on your shop for ${formatKobo(placed.totalK)}. I am ${customerName.trim()}.${note.trim() ? ` Note: ${note.trim()}` : ''}`;
    return (
      <div className="rk-checkout-done" role="status">
        <h2>{placed === 'duplicate' ? 'We already have this order' : 'Order placed'}</h2>
        {placed === 'duplicate' ? (
          <p>Your earlier tap went through, so nothing was ordered twice.</p>
        ) : (
          <p>
            Order <strong>{placed.orderNumber}</strong> for{' '}
            <strong>{formatKobo(placed.totalK)}</strong> is with {displayName}.
          </p>
        )}
        <a
          className="rk-btn rk-checkout-wa"
          href={`https://wa.me/${digits}?text=${encodeURIComponent(handoff)}`}
        >
          Send it to {displayName} on WhatsApp
        </a>
        <p className="rk-fineprint">
          The WhatsApp message is already written, with your order number in it. Sending it is how{' '}
          {displayName} confirms delivery and payment with you.
        </p>
        <p className="rk-fineprint">
          <a href={`/s/${slug}`}>Back to the shop</a>
        </p>
      </div>
    );
  }

  if (cart === null) {
    return <p className="rk-fineprint">Opening your order…</p>;
  }

  if (cart.lines.length === 0) {
    return (
      <p className="rk-fineprint">
        Your order is empty. <a href={`/s/${slug}`}>Back to {displayName}&#39;s shop</a> to add
        items.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="rk-form rk-checkout-form" noValidate>
      <ul className="rk-cart-lines">
        {cart.lines.map((line) => (
          <li key={line.productId} className="rk-cart-line">
            <div className="rk-cart-line-name">
              <span>{line.name}</span>
              <span className="rk-fineprint">{formatKobo(line.priceK)} each</span>
            </div>
            <div className="rk-cart-line-qty">
              <button
                type="button"
                className="rk-btn"
                aria-label={`One less ${line.name}`}
                onClick={() => setCart(setQuantity(slug, line.productId, line.quantity - 1))}
              >
                &minus;
              </button>
              <span aria-live="polite">{line.quantity}</span>
              <button
                type="button"
                className="rk-btn"
                aria-label={`One more ${line.name}`}
                onClick={() => setCart(setQuantity(slug, line.productId, line.quantity + 1))}
              >
                +
              </button>
            </div>
            <span className="rk-cart-line-total">{formatKobo(line.priceK * line.quantity)}</span>
          </li>
        ))}
      </ul>
      <p className="rk-cart-total">
        Total <strong>{formatKobo(cartTotalK(cart))}</strong>
      </p>

      <Field id="checkout-name" label="Your name">
        <input
          className="rk-input"
          name="name"
          autoComplete="name"
          value={customerName}
          onChange={(event) => setCustomerName(event.target.value)}
          maxLength={80}
          required
        />
      </Field>
      <Field
        id="checkout-phone"
        label="Your phone number"
        hint={`The number ${displayName} can reach you on. WhatsApp is best.`}
      >
        <input
          className="rk-input"
          name="phone"
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          maxLength={20}
          required
        />
      </Field>
      <Field
        id="checkout-note"
        label="Anything they should know (optional)"
        hint={`Delivery address or instructions. This goes only in your WhatsApp message to ${displayName}; Rekoda does not keep it.`}
      >
        <textarea
          className="rk-input"
          name="note"
          rows={2}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={300}
        />
      </Field>

      {refusal ? (
        <p className="rk-fineprint" role="alert">
          {refusal}{' '}
          {shopClosed ? (
            <a href={`https://wa.me/${digits}`}>Message them on WhatsApp instead.</a>
          ) : null}
        </p>
      ) : null}

      <button type="submit" className="rk-btn rk-checkout-place" disabled={sending}>
        {sending ? 'Placing your order…' : `Place order · ${formatKobo(cartTotalK(cart))}`}
      </button>
      <p className="rk-fineprint">
        Placing the order sends it to {displayName} with today&#39;s prices. You pay them directly,
        the way you agree together.
      </p>
    </form>
  );
}
