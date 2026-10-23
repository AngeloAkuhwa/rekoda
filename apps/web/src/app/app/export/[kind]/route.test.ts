/**
 * An export request with no session goes to the sign-in page (G-56).
 *
 * The redirect was built with `new URL('/start', process.env.REKODA_WEB_URL)`,
 * and that variable is optional, so with it unset an unauthenticated
 * `GET /app/export/<kind>` threw "Invalid URL" and answered 500 instead of
 * sending the visitor to sign in. A usable REKODA_WEB_URL still decides the
 * target; without one the redirect is relative, which a browser resolves
 * against the address it asked for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/session-cookies', () => ({ readSessionToken: vi.fn() }));
vi.mock('@/server/client-address', () => ({ clientAddressHeaders: vi.fn(async () => ({})) }));

const { readSessionToken } = await import('@/server/session-cookies');
const { GET } = await import('./route');

const call = (kind: string, url = `https://app.example.test/app/export/${kind}`) =>
  GET(new Request(url), { params: Promise.resolve({ kind }) });

const saved = process.env['REKODA_WEB_URL'];

beforeEach(() => {
  vi.mocked(readSessionToken).mockResolvedValue(undefined as never);
});

afterEach(() => {
  if (saved === undefined) delete process.env['REKODA_WEB_URL'];
  else process.env['REKODA_WEB_URL'] = saved;
});

describe('GET /app/export/[kind] without a session', () => {
  it('redirects to /start when REKODA_WEB_URL is not set', async () => {
    delete process.env['REKODA_WEB_URL'];
    const response = await call('invoices');
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(response.headers.get('location')).toBe('/start');
  });

  it('keeps sending the visitor to the configured web origin when there is one', async () => {
    process.env['REKODA_WEB_URL'] = 'https://rekoda.example.test';
    const response = await call('workbook');
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(response.headers.get('location')).toBe('https://rekoda.example.test/start');
  });

  it.each(['', 'not a url', 'ftp://rekoda.example.test', 'javascript:alert(1)'])(
    'redirects to /start when REKODA_WEB_URL is unusable (%j)',
    async (value) => {
      process.env['REKODA_WEB_URL'] = value;
      const response = await call('workbook');
      expect(response.status).toBeGreaterThanOrEqual(300);
      expect(response.status).toBeLessThan(400);
      expect(response.headers.get('location')).toBe('/start');
    },
  );

  it('still answers 404 for a kind that is not an export, before looking at the session', async () => {
    delete process.env['REKODA_WEB_URL'];
    const response = await call('passwords');
    expect(response.status).toBe(404);
    expect(readSessionToken).not.toHaveBeenCalled();
  });
});
