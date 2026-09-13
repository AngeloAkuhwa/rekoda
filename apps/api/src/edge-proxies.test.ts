/**
 * The proxies in front of Caddy, checked before Caddy serves (G-74).
 *
 * Caddy reads REKODA_EDGE_PROXIES itself, so the boot rules in the api and
 * the worker never see it: a universal value there would make Caddy believe
 * any browser's CF-Connecting-IP or X-Forwarded-For and hand that address on
 * as the visitor, undoing G-43 and G-71 from outside the API.
 */
import { describe, expect, it } from 'vitest';
import { edgeProxyProblem } from './edge-proxies.js';

/** Cloudflare's published ranges (cloudflare.com/ips), the widest of each. */
const CLOUDFLARE = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '104.16.0.0/13',
  '172.64.0.0/13',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2a06:98c0::/29',
].join(' ');

describe('values a deployment legitimately uses', () => {
  it('accepts nothing at all, the documented no-edge-proxy mode', () => {
    expect(edgeProxyProblem(undefined)).toBeNull();
    expect(edgeProxyProblem('')).toBeNull();
    expect(edgeProxyProblem('   ')).toBeNull();
  });

  it("accepts Cloudflare's published ranges, together and one at a time", () => {
    expect(edgeProxyProblem(CLOUDFLARE)).toBeNull();
    for (const entry of CLOUDFLARE.split(' ')) expect(edgeProxyProblem(entry)).toBeNull();
  });

  it.each([
    ['the tabs and newlines an editor leaves', ' 104.16.0.0/13\t2606:4700::/32\n'],
    ["Caddy's own name for the private blocks", 'private_ranges'],
    ['a single proxy address', '203.0.113.7'],
    ['an internal load balancer', '10.0.0.0/8'],
    ['an IPv4-mapped range', '::ffff:172.30.10.0/120'],
  ])('accepts %s', (_label, value) => {
    expect(edgeProxyProblem(value)).toBeNull();
  });
});

describe('values that would let a browser choose its own address', () => {
  it.each([
    '0.0.0.0/0',
    '::/0',
    '::ffff:0:0/96',
    '0.0.0.0/1',
    '128.0.0.0/2',
    '2000::/3',
    '::/16',
    '::/80',
  ])('refuses %s', (value) => {
    expect(edgeProxyProblem(value)).toMatch(
      /REKODA_EDGE_PROXIES trusts .* effectively the whole internet/,
    );
  });

  it('refuses a universal entry hidden in a list of good ones', () => {
    expect(edgeProxyProblem(`${CLOUDFLARE} 0.0.0.0/0`)).toMatch(/REKODA_EDGE_PROXIES trusts/);
    expect(edgeProxyProblem(`0.0.0.0/0 ${CLOUDFLARE}`)).toMatch(/REKODA_EDGE_PROXIES trusts/);
  });
});

describe('values Caddy would read as something else', () => {
  /* Caddy takes `trusted_proxies static a b c`, so a comma-separated list
   * is one token it cannot parse, and the deployment should say so rather
   * than let Caddy fail with its own error after the images are built. */
  it('refuses a comma-separated list, which is the other lists’ format', () => {
    expect(edgeProxyProblem('104.16.0.0/13,2606:4700::/32')).toMatch(/space-separated/);
  });

  it.each([
    ['a name that is not an address', 'cloudflare'],
    ['a shorthand address ipaddr.js would widen', '172.30.10'],
    ['an impossible prefix', '10.0.0.0/33'],
    ['a mapped range wider than the mapped block', '::ffff:0:0/95'],
    ['an unknown keyword', 'public_ranges'],
    ['a property of every object', 'constructor'],
  ])('refuses %s', (_label, value) => {
    expect(edgeProxyProblem(value)).toMatch(/REKODA_EDGE_PROXIES/);
  });
});
