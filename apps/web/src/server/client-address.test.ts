/**
 * The web tier hands on only the address Caddy wrote (G-71): one valid IP in
 * X-Rekoda-Client-IP, and nothing a browser could have chosen.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: vi.fn() }));

const { headers } = await import('next/headers');
const { clientAddressFrom, clientAddressHeaders, CLIENT_ADDRESS_HEADER } =
  await import('./client-address');

const incoming = (entries: Record<string, string>) => new Headers(entries);

describe('clientAddressFrom', () => {
  it('reads the address Caddy wrote', () => {
    expect(clientAddressFrom(incoming({ [CLIENT_ADDRESS_HEADER]: '203.0.113.7' }))).toBe(
      '203.0.113.7',
    );
    expect(clientAddressFrom(incoming({ [CLIENT_ADDRESS_HEADER]: '2001:db8::7' }))).toBe(
      '2001:db8::7',
    );
  });

  it('never takes the visitor from X-Forwarded-For, which a browser can write', () => {
    expect(clientAddressFrom(incoming({ 'x-forwarded-for': '203.0.113.7' }))).toBeNull();
  });

  it.each([
    ['a list', '203.0.113.7, 198.51.100.9'],
    ['a name', 'visitor'],
    ['an out-of-range address', '203.0.113.300'],
    ['a blank', '   '],
  ])('hands on nothing for %s', (_label, value) => {
    expect(clientAddressFrom(incoming({ [CLIENT_ADDRESS_HEADER]: value }))).toBeNull();
  });
});

describe('clientAddressHeaders', () => {
  it('hands on the address of the request being served', async () => {
    vi.mocked(headers).mockResolvedValueOnce(
      incoming({ [CLIENT_ADDRESS_HEADER]: '203.0.113.7' }) as never,
    );
    expect(await clientAddressHeaders()).toEqual({ [CLIENT_ADDRESS_HEADER]: '203.0.113.7' });
  });

  it('names nobody for a request that did not come through Caddy', async () => {
    vi.mocked(headers).mockResolvedValueOnce(
      incoming({ 'x-forwarded-for': '203.0.113.7' }) as never,
    );
    expect(await clientAddressHeaders()).toEqual({});
  });
});

/**
 * Every file that calls the API hands the visitor on. A new route that
 * fetched the API without it would put its visitors back in one shared
 * bucket, silently, so the rule is checked over the source itself.
 */
describe('every call to the API carries the visitor', () => {
  it('holds for each file that fetches from the API', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) files.push(path);
      }
    };
    walk(fileURLToPath(new URL('..', import.meta.url)));
    const callers = files.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /REKODA_API_URL/.test(text) && /\bfetch\(/.test(text);
    });
    expect(callers.length).toBeGreaterThanOrEqual(4);
    for (const file of callers) {
      const text = readFileSync(file, 'utf8');
      const fetches = (text.match(/\bfetch\(/g) ?? []).length;
      const carried = (text.match(/clientAddressHeaders\(\)/g) ?? []).length;
      expect(carried, `${file} fetches the API ${fetches} times`).toBeGreaterThanOrEqual(fetches);
    }
  });
});
