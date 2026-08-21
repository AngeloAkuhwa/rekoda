import type { Metadata } from 'next';
import { formatKobo, MAX_IMAGE_BYTES } from '@rekoda/core';
import { Money } from '@/components/ui/Money';
import { catalogue, shopSettings } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { AppNav } from '../AppNav';
import { SignOutButton } from '../SignOutButton';
import {
  ListingForm,
  SetDescriptionForm,
  SetPriceForm,
  UploadPhotoForm,
  type Choice,
} from './CatalogueForms';
import { ShopForm } from './ShopForm';

export const metadata: Metadata = {
  title: 'Catalogue',
  robots: { index: false, follow: false },
};

/**
 * The price list (MASTER-PLAN §5.3.5).
 *
 * Separate from Stock, and the split is the point. Stock answers "what is on
 * my shelf", which is a count nobody can argue with. This answers "what am I
 * selling it for and what does it look like", which is a set of decisions the
 * merchant makes. Putting a price beside an on-hand figure on one page is how
 * a shop starts reading their inventory as if it were worth its selling
 * price, which is a profit they have not made yet.
 *
 * The rows build themselves the same way they always have: a merchant says
 * "sold 2 bags of rice" and a rice row appears. There is still no setup
 * screen to fill in first, and this page exists to finish what conversation
 * cannot say.
 */
export default async function CataloguePage() {
  const { token } = await requireSessionWithToken();
  const [{ products, unpriced }, settings] = await Promise.all([
    catalogue(token),
    shopSettings(token),
  ]);

  /* Every picker gets the price and the count as well as the name: two
   * similar products in one shop is the ordinary case, and a list of bare
   * names is a coin toss. Same rule as the spend register's withdraw control. */
  const choices: Choice[] = products.map((product) => ({
    id: product.id,
    label:
      `${product.name} · ` +
      `${product.unitPriceK === null ? 'no price' : formatKobo(product.unitPriceK)} · ` +
      `${product.onHand} on hand`,
  }));

  const listed = products.filter((product) => product.active);
  const hidden = products.filter((product) => !product.active);

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">Catalogue</p>
          <h1>What you sell, and for how much</h1>
        </div>
        <SignOutButton />
      </header>

      <AppNav active="catalogue" />

      {/* Only when there is something to fix. A banner reading "0 without a
          price" teaches a merchant to scroll past the thing that will matter
          most the day they connect a shop. */}
      {unpriced > 0 ? (
        <div className="rk-card">
          <h2>
            {unpriced === 1 ? 'One product has no price' : `${unpriced} products have no price`}
          </h2>
          <p className="rk-fineprint">
            A product with no price cannot be sold from a shop link or a catalogue, because there is
            nothing to charge. Your books are unaffected: a price here is what you offer, and what
            something actually sold for is on its invoice.
          </p>
        </div>
      ) : null}

      {/* Below the products, because a shop is what a priced catalogue turns
          into. A merchant who has not set a price yet cannot open one, and
          the form says so rather than failing when they try. */}
      <div className="rk-card">
        <h2>Your shop</h2>
        <p className="rk-fineprint">
          A page customers can open, showing what you have listed and priced. There is no cart and
          no card details: tapping an item messages you on WhatsApp with the order already written,
          and forwarding that message to Rekoda prices it and raises the invoice.
        </p>
        {settings.shop?.publishedAt ? (
          <p className="rk-fineprint">
            Open at <strong>rekoda.app/s/{settings.shop.slug}</strong>. Share that link anywhere.
          </p>
        ) : (
          <p className="rk-fineprint">
            Nothing is public until you open it, and closing it again takes one change.
          </p>
        )}
        <details className="rk-void">
          <summary>{settings.shop ? 'Change your shop' : 'Set up your shop'}</summary>
          <ShopForm
            current={
              settings.shop
                ? {
                    slug: settings.shop.slug,
                    displayName: settings.shop.displayName,
                    tagline: settings.shop.tagline,
                    published: settings.shop.publishedAt !== null,
                  }
                : null
            }
            suggestedSlug={settings.suggestedSlug}
          />
        </details>
      </div>

      <div className="rk-card">
        <h2>Your products</h2>
        {products.length === 0 ? (
          <p className="rk-fineprint">
            Nothing here yet. Rekoda adds a product the first time you mention it, so tell it on
            WhatsApp what you sold or what came in, like <strong>sold 2 bags of rice</strong>, and
            the row appears. Then come back and give it a price and a photo.
          </p>
        ) : (
          <>
            <div className="rk-table-scroll">
              <table className="rk-table">
                <thead>
                  <tr>
                    <th>Photo</th>
                    <th>Product</th>
                    <th>What it is</th>
                    <th>In the shop</th>
                    <th className="rk-num">On hand</th>
                    <th className="rk-num">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((product) => (
                    <tr key={product.id}>
                      <td>
                        {product.imagePath ? (
                          /* Our own route, not the API's. `imagePath` says
                             THAT there is a photo; where a browser can fetch
                             it from is this tier's business, because an
                             `<img>` sends cookies and the API wants a bearer
                             token. See app/product-photo/[id]. */
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img
                            src={`/app/product-photo/${product.id}`}
                            alt=""
                            width={44}
                            height={44}
                            className="rk-thumb"
                          />
                        ) : (
                          <span className="rk-fineprint">none</span>
                        )}
                      </td>
                      <td>{product.name}</td>
                      <td>{product.description ?? 'Not described'}</td>
                      <td>{product.active ? 'Listed' : 'Hidden'}</td>
                      <td className="rk-num">{product.onHand}</td>
                      <td className="rk-num">
                        {product.unitPriceK === null ? (
                          <span className="rk-fineprint">no price</span>
                        ) : (
                          <Money kobo={product.unitPriceK} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <details className="rk-void">
              <summary>Set a price</summary>
              <p className="rk-fineprint">
                What you offer it for today. Changing it never touches an invoice you have already
                issued: what something sold for is a fact about that sale, and it stays.
              </p>
              <SetPriceForm choices={choices} />
            </details>

            <details className="rk-void">
              <summary>Write a description</summary>
              <p className="rk-fineprint">
                Your words, not Rekoda&apos;s. Nothing here is generated, because a description
                Rekoda invented would be Rekoda making a claim about goods it has never seen.
              </p>
              <SetDescriptionForm choices={choices} />
            </details>

            <details className="rk-void">
              <summary>Add a photo</summary>
              <p className="rk-fineprint">
                One photo per product, and a new one replaces the old. It is stored privately and
                only shown to you until you connect a shop.
              </p>
              <UploadPhotoForm choices={choices} maxBytes={MAX_IMAGE_BYTES} />
            </details>

            <details className="rk-void">
              <summary>Take something out of the shop, or put it back</summary>
              <p className="rk-fineprint">
                Hiding a product stops customers seeing it and changes nothing else. It stays in
                your books, it stays on your stock count, and telling Rekoda you sold one still
                works: a product you are not advertising is still a product you own.
              </p>
              <ListingForm choices={choices} />
            </details>

            <p className="rk-fineprint">
              {listed.length === 1 ? 'One product' : `${listed.length} products`} in the shop
              {hidden.length > 0 ? ` · ${hidden.length} hidden` : ''}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
