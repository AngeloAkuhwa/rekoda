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
    ['the spaces and tabs an editor leaves', ' 104.16.0.0/13\t2606:4700::/32 '],
    ["Caddy's own name for the private blocks", 'private_ranges'],
    ['a single proxy address', '203.0.113.7'],
    ['an internal load balancer', '10.0.0.0/8'],
    /* Accepted for parity with the API's own lists, which fold a mapped
     * range to the IPv4 one it means. Caddy unmaps the peer instead, so a
     * mapped range there matches nothing; harmless either way. */
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

  /* Every entry inside the per-entry width, and the union still the whole
   * internet: 256 slices of /8, or two halves written as quarters. */
  it('refuses a universal list assembled out of allowed-size entries', () => {
    const everyEighth = Array.from({ length: 256 }, (_, i) => `${i}.0.0.0/8`).join(' ');
    expect(edgeProxyProblem(everyEighth)).toMatch(/REKODA_EDGE_PROXIES trusts/);
    expect(edgeProxyProblem('8.0.0.0/8 9.0.0.0/8 11.0.0.0/8')).toMatch(
      /REKODA_EDGE_PROXIES trusts/,
    );
    const everyIpv6 = Array.from({ length: 8 }, (_, i) => `${i}000::/16`).join(' ');
    expect(edgeProxyProblem(everyIpv6)).toMatch(/REKODA_EDGE_PROXIES trusts/);
  });

  it('keeps a real fleet, whose entries add up to far less', () => {
    expect(edgeProxyProblem(CLOUDFLARE)).toBeNull();
    expect(edgeProxyProblem('10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 fc00::/7')).toBeNull();
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

  /* A line break reaches Caddy as part of the value and it refuses the whole
   * file, so the deployment stops either way; saying so here names the line
   * instead of leaving an operator with a Caddyfile parse error. */
  it('refuses a value broken across lines, which Caddy cannot read', () => {
    expect(edgeProxyProblem('104.16.0.0/13\n2606:4700::/32')).toMatch(/one line/);
    expect(edgeProxyProblem('104.16.0.0/13\r\n2606:4700::/32')).toMatch(/one line/);
  });

  it.each([
    ['a name that is not an address', 'cloudflare'],
    ['a shorthand address ipaddr.js would widen', '172.30.10'],
    ['an impossible prefix', '10.0.0.0/33'],
    ['a mapped range wider than the mapped block', '::ffff:0:0/95'],
    ['an unknown keyword', 'public_ranges'],
    ['a prefix written with a leading zero, which Caddy refuses', '172.16.0.0/012'],
    ['nothing but a line break', '\n'],
    ['a property of every object', 'constructor'],
  ])('refuses %s', (_label, value) => {
    expect(edgeProxyProblem(value)).toMatch(/REKODA_EDGE_PROXIES/);
  });
});
