/**
 * The proxies in front of Caddy, checked before Caddy serves (G-74, G-75).
 *
 * Caddy reads REKODA_EDGE_PROXIES itself, so the boot rules in the api and
 * the worker never see it: a universal value there would make Caddy believe
 * any browser's CF-Connecting-IP or X-Forwarded-For and hand that address on
 * as the visitor, undoing G-43 and G-71 from outside the API. So would a
 * value holding the edge network's gateway, the address Docker hands Caddy
 * every IPv6 visitor and every hairpin connection from.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EDGE_GATEWAY, edgeProxyProblem } from './edge-proxies.js';

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
    ['a single proxy address', '203.0.113.7'],
    ['an internal load balancer', '10.0.0.0/8'],
    /* The deploy smoke's stand-in for Cloudflare: one fixed address on the
     * edge network, which is not the gateway. */
    ['one address on the edge network beside the gateway', '172.30.10.20'],
    ['the neighbours of the gateway, without it', '172.30.10.2/31'],
    /* Accepted for parity with the API's own lists, which fold a mapped
     * range to the IPv4 one it means. Caddy unmaps the peer instead, so a
     * mapped range there matches nothing; harmless either way. */
    ['an IPv4-mapped range', '::ffff:104.16.0.0/109'],
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
   * internet. None of these entries is refused on its own, so each case
   * reaches the sum and fails there, for either family. */
  it('refuses a universal list assembled out of allowed-size entries', () => {
    const everyEighth = Array.from({ length: 256 }, (_, i) => `${i}.0.0.0/8`).join(' ');
    expect(edgeProxyProblem(everyEighth)).toMatch(/IPv4 addresses between its entries/);
    expect(edgeProxyProblem('8.0.0.0/8 9.0.0.0/8 11.0.0.0/8')).toMatch(
      /IPv4 addresses between its entries/,
    );
    for (const value of ['2000::/16 2001::/16', '2400::/16 2600::/17 2a00::/17']) {
      expect(edgeProxyProblem(value)).toMatch(/IPv6 addresses between its entries/);
    }
  });

  it('keeps lists whose public entries add up to far less, or none at all', () => {
    expect(edgeProxyProblem(CLOUDFLARE)).toBeNull();
    expect(edgeProxyProblem('2400::/16')).toBeNull();
    expect(edgeProxyProblem('2400::/17 2600::/17')).toBeNull();
    expect(edgeProxyProblem('10.0.0.0/8 192.168.0.0/16 fc00::/7')).toBeNull();
  });

  it('refuses a universal entry hidden in a list of good ones', () => {
    expect(edgeProxyProblem(`${CLOUDFLARE} 0.0.0.0/0`)).toMatch(/REKODA_EDGE_PROXIES trusts/);
    expect(edgeProxyProblem(`0.0.0.0/0 ${CLOUDFLARE}`)).toMatch(/REKODA_EDGE_PROXIES trusts/);
  });
});

describe("values that would trust the edge network's gateway (G-75)", () => {
  /* Caddy's own name for the private blocks, 172.16.0.0/12 among them. The
   * owner ruled it out for any real deployment (OD-13). */
  it('refuses private_ranges, naming why', () => {
    for (const value of ['private_ranges', `${CLOUDFLARE} private_ranges`]) {
      const problem = edgeProxyProblem(value);
      expect(problem).toMatch(/REKODA_EDGE_PROXIES must not name private_ranges/);
      expect(problem).toMatch(/the edge network's gateway/);
    }
  });

  it.each([
    ['the gateway itself', '172.30.10.1'],
    ['the edge network', '172.30.10.0/24'],
    ['the private block the edge network sits in', '172.16.0.0/12'],
    ['a narrower block around it', '172.30.0.0/16'],
    ['the pair of addresses it starts', '172.30.10.0/31'],
    ['the gateway in IPv4-mapped form', '::ffff:172.30.10.1'],
    ['the edge network in IPv4-mapped form', '::ffff:172.30.10.0/120'],
    ['the gateway hidden among good entries', `${CLOUDFLARE} 172.30.10.1`],
    [
      'private_ranges spelled out, as Caddy expands it',
      '192.168.0.0/16 172.16.0.0/12 10.0.0.0/8 127.0.0.1/8 fd00::/8 ::1',
    ],
  ])('refuses %s', (_label, value) => {
    expect(edgeProxyProblem(value)).toMatch(
      /REKODA_EDGE_PROXIES trusts .* which holds the edge network's gateway \(172\.30\.10\.1\)/,
    );
  });

  /* The rule is only as good as the address it knows: this is the gateway
   * the production compose file pins for the edge network. */
  it('knows the gateway the production compose file pins', () => {
    const compose = readFileSync(
      new URL('../../../docker-compose.prod.yml', import.meta.url),
      'utf8',
    );
    const edge = compose.slice(compose.indexOf('\n  edge:\n', compose.indexOf('\nnetworks:\n')));
    expect(edge).toMatch(/\n {8}- subnet: 172\.30\.10\.0\/24\n/);
    const pinned = edge.match(/\n {10}gateway: (\S+)\n/)?.[1];
    expect(pinned, 'the edge network must pin its gateway').toBeTypeOf('string');
    expect(pinned).toBe(EDGE_GATEWAY);
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
