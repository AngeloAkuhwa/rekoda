import { NextResponse } from 'next/server';
import { readSessionToken } from '@/server/session-cookies';

/**
 * A product photo, proxied.
 *
 * The same reason the export link is proxied: the session is a bearer token
 * this tier holds server-side, and a browser fetching an `<img src>` sends
 * cookies, not authorization headers. Pointing the tag straight at the API
 * would 401 every time; putting the token in the URL to fix that would write
 * a live credential into browser history, referrer headers and every proxy
 * log between here and the merchant.
 *
 * Nothing about the image is decided here. The API owns the tenant pin, reads
 * the type from the bytes themselves, and refuses anything that is not one of
 * three raster formats. This is a pipe.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The only three the API will ever serve. Anything else is not passed on. */
const SERVABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  /* Checked before it is interpolated. An id is a path segment somebody can
   * type, and building an upstream URL out of one unchecked is how a proxy
   * becomes a way to reach other routes on its own API. */
  if (!UUID.test(id)) return new NextResponse('Not found', { status: 404 });

  const token = await readSessionToken();
  if (!token) return new NextResponse('Not found', { status: 404 });

  const base = process.env.REKODA_API_URL ?? 'http://127.0.0.1:3001';
  const upstream = await fetch(`${base}/v1/catalogue/${id}/image`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!upstream.ok) return new NextResponse('Not found', { status: 404 });

  /* The API sniffed the bytes; this refuses to pass on anything outside the
   * three formats regardless. A pipe that would forward `text/html` if the
   * thing upstream ever changed is a pipe that can serve a document from our
   * own origin. */
  const type = upstream.headers.get('content-type') ?? '';
  if (!SERVABLE.has(type)) return new NextResponse('Not found', { status: 404 });

  return new NextResponse(await upstream.arrayBuffer(), {
    headers: {
      'content-type': type,
      /* Private and short. One merchant's product photo must never sit in a
       * shared cache where the next request on the same edge could get it. */
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
    },
  });
}
