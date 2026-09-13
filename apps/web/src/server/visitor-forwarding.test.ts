/**
 * Every place the web tier calls the API hands the API the visitor Caddy
 * named, on the request that actually leaves (G-71). The source scan in
 * client-address.test.ts only proves the helper is called; this proves its
 * result reaches fetch, for each of the five call sites: `call()` (sign-in
 * and every dashboard read), the photo upload, and the three route handlers.
 * Drop the header from any of them and that site's visitors are back in the
 * web tier's one bucket, with every other check still green.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }));

const { headers, cookies } = await import('next/headers');
const api = await import('./api');
const exportRoute = await import('@/app/app/export/[kind]/route');
const productPhoto = await import('@/app/app/product-photo/[id]/route');
const shopPhoto = await import('@/app/s/[slug]/photo/[id]/route');

const VISITOR = '203.0.113.7';
const PHOTO = '0b8e7a5c-3f4d-4b7a-9c1e-2d6f8a9b0c1d';
const fetchMock = vi.fn<typeof fetch>();

/** The visitor header on the one request that left for the API. */
function sentVisitor(): string | null {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const init = fetchMock.mock.calls[0]?.[1];
  return new Headers(init?.headers).get('x-rekoda-client-ip');
}

const SITES: [string, () => Promise<unknown>][] = [
  ['call(), for a sign-in code', () => api.requestOtp('+2348000000000')],
  ['call(), for a dashboard read', () => api.me('session-token')],
  [
    'the photo upload',
    () =>
      api.uploadProductImage(
        'session-token',
        PHOTO,
        new File(['x'], 'a.png', { type: 'image/png' }),
      ),
  ],
  [
    'the export route',
    () =>
      exportRoute.GET(new Request('https://rekoda.localhost/app/export/invoices'), {
        params: Promise.resolve({ kind: 'invoices' }),
      }),
  ],
  [
    'the dashboard photo route',
    () =>
      productPhoto.GET(new Request('https://rekoda.localhost/'), {
        params: Promise.resolve({ id: PHOTO }),
      }),
  ],
  [
    'the storefront photo route',
    () =>
      shopPhoto.GET(new Request('https://rekoda.localhost/'), {
        params: Promise.resolve({ slug: 'a-shop', id: PHOTO }),
      }),
  ],
];

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(cookies).mockResolvedValue({
    get: () => ({ name: 'rk_session', value: 'session-token' }),
  } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the visitor reaches the API from every call site', () => {
  it.each(SITES)('%s sends the address Caddy wrote', async (_site, run) => {
    vi.mocked(headers).mockResolvedValue(new Headers({ 'x-rekoda-client-ip': VISITOR }) as never);
    await run().catch(() => undefined);
    expect(sentVisitor()).toBe(VISITOR);
  });

  it.each(SITES)('%s sends nothing a browser wrote', async (_site, run) => {
    vi.mocked(headers).mockResolvedValue(
      new Headers({ 'x-forwarded-for': '198.51.100.9' }) as never,
    );
    await run().catch(() => undefined);
    expect(sentVisitor()).toBeNull();
  });
});
