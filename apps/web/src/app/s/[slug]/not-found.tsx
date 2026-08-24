/**
 * A dead shop link, answered for the CUSTOMER holding it.
 *
 * Without this boundary the nearest not-found was the app's, which said
 * "Your records are unaffected" and offered "Go to your dashboard" to a
 * person who has never had one. A shop link travels on WhatsApp long after
 * a shop is taken down; the person opening it deserves a sentence written
 * for them.
 */
export default function ShopNotFound() {
  return (
    <div className="rk-container" style={{ padding: '4rem 0', textAlign: 'center' }}>
      <h1>This shop is not here any more</h1>
      <p className="rk-fineprint">
        The link may be old, or the seller may have taken their page down. If somebody sent it to
        you, ask them on WhatsApp what they are selling now.
      </p>
    </div>
  );
}
