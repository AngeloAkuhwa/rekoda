import type { Metadata } from 'next';
import { reportsStock } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { Money } from '@/components/ui/Money';
import { AppNav } from '../AppNav';
import { exportCaption } from '@/lib/export-caption';
import { SignOutButton } from '../SignOutButton';
import { heldBy } from '@/lib/capabilities';

export const metadata: Metadata = {
  title: 'Stock',
  robots: { index: false, follow: false },
};

/**
 * What is on the shelf.
 *
 * On-hand is `SUM(delta)` over an append-only movement ledger, never a stored
 * count: the same discipline the money ledger runs under, applied to things.
 * A shop's product list builds itself out of what the merchant actually
 * counts and sells, so there is no setup screen here to fill in first.
 *
 * No money on this page, deliberately. A product's price is what it sells
 * FOR, and showing a valuation would assert a cost basis Rekoda does not
 * hold: what a merchant paid for the stock they are holding is a purchase
 * question, and mixing the two is how a shop reads a profit that is not there.
 */
export default async function StockPage() {
  const { identity, token } = await requireSessionWithToken();
  const { products, total, outOfStock, withoutCost } = await reportsStock(token);

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">Stock</p>
          <h1>What you have on hand</h1>
        </div>
        <SignOutButton />
      </header>

      <AppNav active="stock" held={heldBy(identity)} />

      <div className="rk-card">
        <h2>Stock register</h2>
        {total === 0 ? (
          <p className="rk-fineprint">
            You are not counting any stock yet. Tell Rekoda on WhatsApp what you have, like{' '}
            <strong>add 20 bags of rice</strong>, and the count keeps itself from there. Stock you
            buy is added when you record the purchase, and every sale takes it off the shelf.
          </p>
        ) : (
          <>
            <div className="rk-table-scroll">
              <table className="rk-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="rk-num">On hand</th>
                    {/* What it cost, not what it sells for. The two are
                        different questions and a shop that reads one as the
                        other reads a profit that is not there. */}
                    <th className="rk-num">What it cost you</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Lowest first, from the API. The row that needs the
                      merchant is the one about to run out, and a list sorted
                      by name is a list somebody has to read all of. */}
                  {products.map((product) => (
                    <tr key={product.name}>
                      <td>{product.name}</td>
                      <td className="rk-num">{product.onHand}</td>
                      <td className="rk-num">
                        {product.unitCostK === null ? (
                          <span className="rk-fineprint">Not recorded</span>
                        ) : (
                          <Money kobo={product.unitCostK} />
                        )}
                      </td>
                      <td>
                        {product.onHand <= 0 ? (
                          <span className="rk-status-warn">Out of stock</span>
                        ) : (
                          <span className="rk-fineprint">In stock</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="rk-fineprint">
              <a href="/app/export/stock" download>
                {exportCaption('products', total)}
              </a>
            </p>
            {/* The counts describe the shop, not the table above it. The
                table is a page, and a footer that counted its own rows would
                tell a merchant with more products than fit that they have
                exactly as many as fit. */}
            <p className="rk-fineprint">
              {total === 1 ? 'One product' : `${total} products`} counted
              {total > products.length ? (
                <>
                  {' · '}
                  showing the {products.length} lowest
                </>
              ) : null}
              {outOfStock > 0 ? (
                <>
                  {' · '}
                  {outOfStock === 1 ? 'one has' : `${outOfStock} have`} run out
                </>
              ) : null}
              . Counts come from what you record on WhatsApp: what you add, what you buy, and what
              each sale takes away.
            </p>
            {/* The line that explains a profit and loss with no cost of sales
                on it. A merchant reading "gross profit equals sales" is owed
                the reason rather than left to work it out. */}
            {withoutCost > 0 ? (
              <p className="rk-fineprint">
                {withoutCost === 1 ? 'One product has' : `${withoutCost} products have`} no cost
                recorded, so selling {withoutCost === 1 ? 'it' : 'them'} shows income with nothing
                against it. A cost is set when you record buying it, like{' '}
                <strong>bought 10 bags of rice for 45k</strong>.
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
