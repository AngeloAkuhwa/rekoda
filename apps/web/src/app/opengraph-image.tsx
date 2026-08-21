import { ImageResponse } from 'next/og';

/**
 * The card a Rekoda link becomes when somebody shares it.
 *
 * This matters more here than on most products: Rekoda is sold by merchants
 * telling other merchants, on WhatsApp, and a link with no card is a grey
 * rectangle nobody taps. Generated rather than a checked-in PNG so the words
 * and the mark cannot drift from the ones on the page.
 */
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Rekoda. You run the business. Rekoda builds the records.';

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '80px',
        background: '#fcfcfb',
        color: '#1c1b19',
      }}
    >
      <div style={{ fontSize: 44, color: '#0f766e', fontWeight: 700, marginBottom: 28 }}>
        Rekoda
      </div>
      <div style={{ fontSize: 68, lineHeight: 1.15, maxWidth: 900 }}>
        You run the business. Rekoda builds the records.
      </div>
      <div style={{ fontSize: 34, color: '#6b6862', marginTop: 32 }}>
        Real invoices, real receipts, real books, from WhatsApp.
      </div>
    </div>,
    size,
  );
}
