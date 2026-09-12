/**
 * Who a request is from, for the per-IP limit (G-71): the vouched visitor
 * only from the web tier, the proxy-derived address from everyone else, and
 * one bucket per IPv4 address or IPv6 /64.
 */
import { describe, expect, it } from 'vitest';
import {
  CLIENT_ADDRESS_HEADER,
  clientAddress,
  parseTrustedWeb,
  rateLimitKey,
} from './client-address.js';

const WEB = parseTrustedWeb('172.30.10.11');
const request = (peer: string, ip: string, headers: Record<string, string | string[]> = {}) => ({
  ip,
  socket: { remoteAddress: peer },
  headers,
});

describe('clientAddress', () => {
  it('believes the web tier about the visitor it calls for', () => {
    const r = request('172.30.10.11', '172.30.10.11', { [CLIENT_ADDRESS_HEADER]: '203.0.113.7' });
    expect(clientAddress(r, WEB)).toBe('203.0.113.7');
  });

  it('believes the web tier over an IPv4-mapped socket address', () => {
    const r = request('::ffff:172.30.10.11', '::ffff:172.30.10.11', {
      [CLIENT_ADDRESS_HEADER]: '203.0.113.7',
    });
    expect(clientAddress(r, WEB)).toBe('203.0.113.7');
  });

  it('ignores the header from Caddy, whose word is the X-Forwarded-For entry', () => {
    /* Fastify has already turned Caddy's X-Forwarded-For into request.ip. */
    const r = request('172.30.10.10', '198.51.100.9', { [CLIENT_ADDRESS_HEADER]: '203.0.113.7' });
    expect(clientAddress(r, WEB)).toBe('198.51.100.9');
  });

  it('ignores the header from a direct caller, who cannot borrow a bucket', () => {
    const r = request('198.51.100.9', '198.51.100.9', { [CLIENT_ADDRESS_HEADER]: '203.0.113.7' });
    expect(clientAddress(r, WEB)).toBe('198.51.100.9');
  });

  it('ignores the header everywhere when no web tier is configured', () => {
    const r = request('172.30.10.11', '172.30.10.11', { [CLIENT_ADDRESS_HEADER]: '203.0.113.7' });
    expect(clientAddress(r, [])).toBe('172.30.10.11');
  });

  it.each([
    ['a list', '203.0.113.7, 198.51.100.9'],
    ['a name', 'visitor'],
    ['an out-of-range address', '203.0.113.300'],
    ['nothing', ''],
  ])('falls back to the web tier itself for %s', (_label, value) => {
    const r = request('172.30.10.11', '172.30.10.11', { [CLIENT_ADDRESS_HEADER]: value });
    expect(clientAddress(r, WEB)).toBe('172.30.10.11');
  });

  it('falls back when the header was sent twice', () => {
    const r = request('172.30.10.11', '172.30.10.11', {
      [CLIENT_ADDRESS_HEADER]: ['203.0.113.7', '198.51.100.9'],
    });
    expect(clientAddress(r, WEB)).toBe('172.30.10.11');
  });

  it('accepts an IPv6 visitor, and a web tier given as a CIDR', () => {
    const r = request('10.1.2.3', '10.1.2.3', { [CLIENT_ADDRESS_HEADER]: '2001:db8::1' });
    expect(clientAddress(r, parseTrustedWeb('10.0.0.0/8'))).toBe('2001:db8::1');
  });
});

describe('rateLimitKey', () => {
  it('keys IPv4 by address', () => {
    expect(rateLimitKey('203.0.113.7')).toBe('v4:203.0.113.7');
    expect(rateLimitKey('203.0.113.8')).not.toBe(rateLimitKey('203.0.113.7'));
  });

  it('keys IPv4-mapped IPv6 as the IPv4 address it carries', () => {
    expect(rateLimitKey('::ffff:203.0.113.7')).toBe(rateLimitKey('203.0.113.7'));
  });

  it('keys IPv6 by its /64, so rotating within one allocation resets nothing', () => {
    expect(rateLimitKey('2001:db8:1:2::1')).toBe(rateLimitKey('2001:db8:1:2:ffff::9'));
    expect(rateLimitKey('2001:db8:1:2::1')).not.toBe(rateLimitKey('2001:db8:1:3::1'));
  });

  it('keeps something unparseable as its own key', () => {
    expect(rateLimitKey('unknown')).toBe('raw:unknown');
  });
});

describe('parseTrustedWeb', () => {
  it('refuses an entry that is not an address or CIDR, naming it', () => {
    expect(() => parseTrustedWeb('172.30.10.11,web')).toThrow(/not an address or CIDR: web/);
  });

  it('is empty only when nothing was set', () => {
    expect(parseTrustedWeb(undefined)).toEqual([]);
    expect(parseTrustedWeb('  ')).toEqual([]);
  });

  /* Production requires the list, and a value of bare separators would pass
   * a "set" check while trusting nobody: every visitor back in web's bucket. */
  it.each([',', ' , ', ',,'])('refuses %j, which is set but names no address', (value) => {
    expect(() => parseTrustedWeb(value)).toThrow(/names no address/);
  });

  /* Peers are compared in canonical form, where an IPv4-mapped address is
   * IPv4; a range written in mapped form must mean the same IPv4 range, or
   * it silently matches no peer at all. */
  it.each(['::ffff:172.30.10.0/120', '::ffff:172.30.10.11/128', '::ffff:172.30.10.11'])(
    'reads %s as the IPv4 range it means',
    (value) => {
      const web = parseTrustedWeb(value);
      for (const peer of ['172.30.10.11', '::ffff:172.30.10.11']) {
        const r = request(peer, peer, { [CLIENT_ADDRESS_HEADER]: '203.0.113.7' });
        expect(clientAddress(r, web), `${value} from ${peer}`).toBe('203.0.113.7');
      }
    },
  );

  it('refuses a mapped range wider than the IPv4-mapped block', () => {
    expect(() => parseTrustedWeb('::ffff:0:0/95')).toThrow(/wider than the IPv4-mapped block/);
  });
});
