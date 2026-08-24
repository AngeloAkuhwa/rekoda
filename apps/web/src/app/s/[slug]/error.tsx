'use client';

/**
 * The shop's own boundary. A customer following a merchant's link must
 * never meet a stack trace wearing the merchant's name: this page is the
 * merchant's storefront, and the calmest true sentence is that the shop is
 * briefly unavailable, not broken, not gone.
 */
export default function ShopError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="rk-container" style={{ padding: '4rem 0', textAlign: 'center' }}>
      <h1>This shop is briefly unavailable</h1>
      <p>Nothing is wrong with the shop itself. Give it a moment and try again.</p>
      <p>
        <button type="button" className="rk-btn" onClick={() => reset()}>
          Try again
        </button>
      </p>
    </div>
  );
}
