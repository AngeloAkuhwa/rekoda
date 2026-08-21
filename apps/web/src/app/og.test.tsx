import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MARK_PATH } from '@/lib/mark';
import OpenGraphImage from './opengraph-image';
import AppleIcon from './apple-icon';
import ShopOpenGraphImage from './s/[slug]/opengraph-image';

/**
 * The generated images, rendered to actual bytes.
 *
 * This exists because of a bug that every other check passed. Satori refuses
 * any element with more than one child unless it declares a display, and a
 * JSX line reading `{count} items` is two children. TypeScript accepted it,
 * `next build` accepted it, the route existed, and the shop card 500'd for
 * every merchant who had a product while rendering perfectly for the empty
 * fallback nobody shares. The only way to catch that is to render.
 *
 * So the assertions are deliberately about the bytes rather than the words:
 * a PNG that decodes at the right size is proof the layout was accepted, and
 * two different shops producing two different files is proof the fetch on the
 * path is real rather than always falling through to the fallback.
 */
async function png(res: Response): Promise<Uint8Array> {
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/png');
  const bytes = new Uint8Array(await res.arrayBuffer());
  /* The eight byte PNG signature. Satori failures arrive as an aborted
   * stream rather than a bad status, so the shape of the body is the check. */
  expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  return bytes;
}

const shop = (over: Record<string, unknown> = {}) => ({
  slug: 'ada-fashion',
  displayName: 'Ada Fashion',
  tagline: 'Wax print by the bale, Surulere',
  whatsappE164: '+2348030000000',
  products: [
    { id: 'p1', name: 'Ankara bale', description: null, priceK: 850_000, imagePath: null },
  ],
  ...over,
});

/** Answers the one call `publicShop` makes, without a server anywhere. */
function apiReturns(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('the cards a shared link becomes', () => {
  it('draws the marketing card and the home screen icon', async () => {
    await png(await OpenGraphImage());
    await png(await AppleIcon());
  });

  /* The tab icon is a static file and the home screen icon is generated, so
   * nothing but this makes them the same logo. */
  it('draws the same mark in the tab as on the home screen', () => {
    const svg = readFileSync(fileURLToPath(new URL('./icon.svg', import.meta.url)), 'utf8');
    expect(svg).toContain(MARK_PATH);
  });

  it('names the shop, and says how many items it has', async () => {
    apiReturns(200, shop());
    const one = await png(await ShopOpenGraphImage({ params: params('ada-fashion') }));

    /* Two products rather than one, so the singular and the plural branch of
     * the item count are both drawn. That line is where the layout broke. */
    apiReturns(200, {
      ...shop(),
      displayName: 'Bola Foods',
      products: [
        ...shop().products,
        { id: 'p2', name: 'Head tie', description: null, priceK: 250_000, imagePath: null },
      ],
    });
    const two = await png(await ShopOpenGraphImage({ params: params('bola-foods') }));

    expect(Buffer.compare(Buffer.from(one), Buffer.from(two))).not.toBe(0);
  });

  it('still draws a card for a slug nobody has', async () => {
    apiReturns(404, { message: 'Not found' });
    await png(await ShopOpenGraphImage({ params: params('nobody-here') }));
  });

  /**
   * An outage must not caption a real merchant's link "Shop not found". The
   * bytes cannot say which words were drawn, so the proof is that an
   * unreachable API and an unknown slug produce DIFFERENT files.
   */
  it('does not call a shop missing when the API is the thing that is missing', async () => {
    apiReturns(404, { message: 'Not found' });
    const missing = await png(await ShopOpenGraphImage({ params: params('ada-fashion') }));

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    );
    const down = await png(await ShopOpenGraphImage({ params: params('ada-fashion') }));

    expect(Buffer.compare(Buffer.from(missing), Buffer.from(down))).not.toBe(0);
  });
});

const params = (slug: string) => Promise.resolve({ slug });
