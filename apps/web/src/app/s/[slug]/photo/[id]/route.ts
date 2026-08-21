import { NextResponse } from 'next/server';

/**
 * A product photo on a public shop page.
 *
 * The same pipe as the dashboard's, minus the session, because this page has
 * none: a customer with a shop link is a stranger. It exists at all for the
 * duller of the two reasons the dashboard's does. The API path is right for
 * an API consumer and wrong for an `<img>`, which asks THIS origin.
 *
 * Everything that decides whether these bytes may be served happens upstream:
 * the API resolves the slug to a published shop, reads the key under that
 * tenant's pin, and refuses anything whose bytes are not one of three raster
 * formats. This forwards and re-checks the type, and nothing else.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SERVABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
): Promise<Response> {
  const { slug, id } = await params;
  /* Both checked before either is interpolated. They are path segments
   * anybody can type, and building an upstream URL out of one unchecked is
   * how a proxy becomes a way to reach other routes on its own API. */
  if (!UUID.test(id) || !SLUG.test(slug) || slug.length > 40) {
    return new NextResponse('Not found', { status: 404 });
  }

  const base = process.env.REKODA_API_URL ?? 'http://127.0.0.1:3001';
  const upstream = await fetch(`${base}/v1/shop/${slug}/photo/${id}`, { cache: 'no-store' });
  if (!upstream.ok) return new NextResponse('Not found', { status: 404 });

  const type = upstream.headers.get('content-type') ?? '';
  if (!SERVABLE.has(type)) return new NextResponse('Not found', { status: 404 });

  return new NextResponse(await upstream.arrayBuffer(), {
    headers: {
      'content-type': type,
      /* Public, unlike every other image this tier serves. It is on a page
       * anyone can open, so a shared cache holding it is the point. */
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
}
