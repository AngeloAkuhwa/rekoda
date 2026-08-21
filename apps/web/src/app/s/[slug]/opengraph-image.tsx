import { ImageResponse } from 'next/og';
import { publicShop } from '@/server/api';

/**
 * The card a merchant's shop link becomes on WhatsApp.
 *
 * The most valuable image in the product, because of how Door 1 is actually
 * used: a merchant does not put their shop on a billboard, they paste the
 * link into a chat. What the customer sees in that chat is this card, and a
 * link with no card is a grey rectangle beside a URL nobody taps.
 *
 * It names the SHOP, never Rekoda's marketing. The merchant is sharing their
 * own storefront, and a card that led with our slogan would be advertising to
 * their customers off their shelf space, the same mistake the header made.
 *
 * Product photos are deliberately not composited in. Fetching and decoding
 * one here would put a bucket round trip on the path of every link preview a
 * crawler asks for, and a shop whose first product has no photo would get a
 * different card from one whose does. The name is the thing a customer
 * recognises anyway.
 */
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function ShopOpenGraphImage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const slug = (await params).slug;
  /**
   * Never throws, and that is the point of the catch.
   *
   * Nobody watches a link preview being generated. If this route 500s during
   * an API outage, the merchant just finds that their link pastes as a bare
   * URL and has no way to know why.
   *
   * The two failures are told apart on purpose. A null is the API answering
   * that there is no such published shop; a throw is the API not answering at
   * all, and captioning a real merchant's link "Shop not found" because our
   * own service is down is a claim about their business that is not true. In
   * that case the card falls back to the handle out of the URL, which is the
   * one thing we still know for certain.
   */
  const shop = await publicShop(slug).catch(() => 'unreachable' as const);

  /* An unpublished or unknown shop still has to answer something: a crawler
   * asks for this before anybody checks whether the page exists. */
  const found = shop !== 'unreachable' && shop !== null ? shop : null;
  const name = found?.displayName ?? (shop === 'unreachable' ? slug : 'Shop not found');
  const tagline = found?.tagline ?? null;
  const count = found?.products.length ?? 0;

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
      <div style={{ fontSize: 76, lineHeight: 1.1, maxWidth: 1000 }}>{name}</div>
      {tagline ? (
        <div style={{ fontSize: 38, color: '#6b6862', marginTop: 28, maxWidth: 1000 }}>
          {tagline}
        </div>
      ) : null}
      {count > 0 ? (
        /* One expression, not two children with a space between them. Satori
         * refuses any div with more than one child unless it declares a
         * display, and a JSX line that mixes an interpolation with literal
         * text is exactly that: the card 500s for every shop that has a
         * product, and only renders for the ones that do not. */
        <div style={{ fontSize: 34, color: '#0f766e', marginTop: 36 }}>
          {`${count === 1 ? '1 item' : `${count} items`} \u00b7 order on WhatsApp`}
        </div>
      ) : null}
    </div>,
    size,
  );
}
