import { NextResponse } from 'next/server';
import { readSessionToken } from '@/server/session-cookies';

/**
 * The download link, proxied.
 *
 * A plain `<a href>` to the API cannot work: the session is a bearer token
 * this tier holds server-side, and a browser following a link sends cookies,
 * not authorization headers. Putting the token in the URL instead would write
 * a live credential into browser history, referrer headers and every proxy
 * log between here and the merchant.
 *
 * So the link points at us, and we spend one round trip with the token we
 * already hold. Nothing about the file is built here: the API owns the tenant
 * pin and the document, and this is a pipe.
 */
const EXPORTS: Readonly<Record<string, string>> = {
  invoices: 'invoices.csv',
  receipts: 'receipts.csv',
  statements: 'statements.pdf',
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ kind: string }> },
): Promise<Response> {
  const { kind } = await params;
  const file = EXPORTS[kind];
  /* An allow-list, not interpolation. `kind` is a path segment somebody can
   * type, and building an upstream URL out of one is how a proxy becomes an
   * open redirect against its own API. */
  if (!file) return new NextResponse('Not found', { status: 404 });

  const token = await readSessionToken();
  if (!token) return NextResponse.redirect(new URL('/start', process.env.REKODA_WEB_URL));

  /* One parameter travels, and only if it looks like a month. Forwarding the
   * caller's query string wholesale would let anything they typed reach the
   * API under their session. */
  const period = new URL(request.url).searchParams.get('period');
  const query = period && /^\d{4}-(0[1-9]|1[0-2])$/.test(period) ? `?period=${period}` : '';

  const base = process.env.REKODA_API_URL ?? 'http://127.0.0.1:3001';
  const upstream = await fetch(`${base}/v1/reports/${file}${query}`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  if (!upstream.ok) {
    return new NextResponse('Could not build your export. Try again in a moment.', {
      status: upstream.status === 401 ? 401 : 502,
    });
  }

  /* Bytes, not text. A PDF read as a string comes back through this pipe
   * re-encoded and unopenable, and it would look fine in every log. */
  return new NextResponse(await upstream.arrayBuffer(), {
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'content-disposition': upstream.headers.get('content-disposition') ?? 'attachment',
      /* A merchant's whole book must not sit in a shared cache. The API says
       * so too; saying it twice costs nothing and a missing header here would
       * undo the one there. */
      'cache-control': 'no-store',
    },
  });
}
