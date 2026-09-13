/**
 * Who a request is from, for the per-IP rate limit (G-71).
 *
 * A browser's request reaches the API by one of two roads, and each road has
 * exactly one party allowed to say who the visitor is:
 *
 *   browser -> Caddy -> API            Caddy decides the client address and
 *                                      writes it as the only X-Forwarded-For
 *                                      entry; Fastify believes it because the
 *                                      TCP peer is Caddy (REKODA_TRUSTED_PROXIES).
 *
 *   browser -> Caddy -> web -> API     Caddy decides the address the same way
 *                                      and writes it to web as
 *                                      X-Rekoda-Client-IP; web passes that one
 *                                      value on, in the same header, on every
 *                                      call it makes for the visitor. The API
 *                                      believes it only when the TCP peer is
 *                                      the web tier (REKODA_TRUSTED_WEB).
 *
 * So the header is not a claim anyone can make. From any peer but the web
 * tier it is ignored, and Caddy removes it from every request it forwards to
 * the API host, so a browser cannot even deliver it. Without this, every
 * request the web tier made (every dashboard page, every storefront order,
 * every sign-in code) arrived from web's one address and shared one bucket.
 */
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

/** The one header the web tier uses to say which visitor it is calling for. */
export const CLIENT_ADDRESS_HEADER = 'x-rekoda-client-ip';

export type Range = [ipaddr.IPv4 | ipaddr.IPv6, number];

/**
 * The web tier's addresses or CIDRs, comma-separated. Anything that does not
 * parse refuses to boot: a trust list that silently drops an entry is a trust
 * list that silently changes who is believed. For the same reason a value
 * that is set but names nothing (bare commas) is refused rather than read as
 * an empty list, which would pass production's "is it set" check while
 * trusting nobody.
 */
export function parseTrustedWeb(raw: string | undefined): Range[] {
  return trustEntries('REKODA_TRUSTED_WEB', raw).map((entry) =>
    parseRange('REKODA_TRUSTED_WEB', entry),
  );
}

/**
 * The names proxy-addr (Fastify's trustProxy) accepts besides addresses,
 * as the ranges it gives them. All three are non-public by definition.
 */
const PROXY_RANGE_NAMES: Readonly<Record<string, readonly string[]>> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
};

/**
 * The proxies whose X-Forwarded-For Fastify believes: the entries exactly as
 * Fastify will read them, and the ranges they mean. Same rules as the web
 * tier's list (plain addresses or CIDRs, nothing set-but-empty), plus
 * proxy-addr's three range names.
 */
export function parseTrustedProxies(raw: string | undefined): {
  entries: string[];
  ranges: Range[];
} {
  const entries = trustEntries('REKODA_TRUSTED_PROXIES', raw);
  const ranges = entries.flatMap((entry) => {
    const named = PROXY_RANGE_NAMES[entry];
    if (named) return named.map((cidr) => ipaddr.parseCIDR(cidr) as Range);
    return [parseRange('REKODA_TRUSTED_PROXIES', entry)];
  });
  return { entries, ranges };
}

function trustEntries(name: string, raw: string | undefined): string[] {
  const entries = (raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (entries.length === 0 && (raw ?? '').trim() !== '') {
    throw new Error(`${name} is set but names no address or CIDR: ${raw}`);
  }
  return entries;
}

function parseRange(name: string, entry: string): Range {
  /* Written as a plain address, as the compose file writes it. ipaddr.js
   * also reads shorthand, octal and integer forms (172.30.10 is
   * 172.30.0.10), so a typo would boot trusting some other peer. */
  const [address = '', prefix, ...extra] = entry.split('/');
  if (
    isIP(address) === 0 ||
    extra.length > 0 ||
    (prefix !== undefined && !/^\d{1,3}$/.test(prefix))
  ) {
    throw new Error(`${name} has an entry that is not an address or CIDR: ${entry}`);
  }
  let range: Range;
  try {
    if (entry.includes('/')) {
      range = ipaddr.parseCIDR(entry) as Range;
    } else {
      const parsed = ipaddr.process(entry);
      range = [parsed, parsed.kind() === 'ipv4' ? 32 : 128];
    }
  } catch {
    throw new Error(`${name} has an entry that is not an address or CIDR: ${entry}`);
  }
  return inIpv4Form(name, range, entry);
}

/**
 * A range written in IPv4-mapped form, as the IPv4 range it means. Peers are
 * compared in canonical form, where a mapped address is IPv4, so a mapped
 * range left as IPv6 would match no peer at all and quietly put every
 * visitor back in the web tier's bucket. A mapped prefix shorter than /96
 * reaches outside the mapped block, so it has no IPv4 meaning and is refused.
 */
function inIpv4Form(name: string, [base, bits]: Range, entry: string): Range {
  if (!(base instanceof ipaddr.IPv6) || !base.isIPv4MappedAddress()) return [base, bits];
  if (bits < 96) {
    throw new Error(`${name} has a range wider than the IPv4-mapped block: ${entry}`);
  }
  return [base.toIPv4Address(), bits - 96];
}

/**
 * Blocks no internet client can hold an address in. A trust range inside
 * one of them, however wide, cannot be claimed from outside the host's own
 * networks.
 */
const NON_PUBLIC = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
].map((cidr) => ipaddr.parseCIDR(cidr) as Range);

/** No real proxy fleet or web tier reaches public space wider than these. */
const WIDEST_PUBLIC = { ipv4: 8, ipv6: 16 } as const;

/**
 * The first address of the IPv4-mapped block. Fastify's proxy matcher turns
 * an IPv4 peer into its mapped form before testing it against an IPv6 range,
 * so an IPv6 range that swallows this block (`::/16`, `::/80`) trusts every
 * IPv4 caller on the internet however long its prefix looks.
 */
const MAPPED_BLOCK = ipaddr.parse('::ffff:0:0');

/**
 * The first entry that trusts effectively the whole internet (G-72): wider
 * than a /8 of IPv4 or a /16 of IPv6 while reaching public address space, so
 * 0.0.0.0/0, ::/0, the mapped ::ffff:0:0/96, and their halves and quarters.
 * Cloudflare's widest published ranges (/13, /29) and every private block
 * pass. Null when there is none.
 */
export function universalRange(ranges: readonly Range[]): Range | null {
  return (
    ranges.find(([base, bits]) => {
      /* An IPv6 range holding the whole mapped block covers every IPv4
       * address, whatever its own prefix length says. */
      if (base.kind() === 'ipv6' && bits <= 96 && MAPPED_BLOCK.match(base, bits)) return true;
      if (bits >= WIDEST_PUBLIC[base.kind()]) return false;
      const insideNonPublic = NON_PUBLIC.some(
        ([block, blockBits]) =>
          block.kind() === base.kind() && bits >= blockBits && base.match(block, blockBits),
      );
      return !insideNonPublic;
    }) ?? null
  );
}

/** An address in one canonical form (IPv4-mapped IPv6 becomes IPv4), or null. */
function canonical(value: string | undefined): ipaddr.IPv4 | ipaddr.IPv6 | null {
  if (!value) return null;
  try {
    return ipaddr.process(value.trim());
  } catch {
    return null;
  }
}

function within(address: ipaddr.IPv4 | ipaddr.IPv6, ranges: readonly Range[]): boolean {
  return ranges.some(([base, bits]) => address.kind() === base.kind() && address.match(base, bits));
}

export interface AddressedRequest {
  /** Fastify's client address: the socket peer, or the X-Forwarded-For entry
   * a trusted proxy (Caddy) wrote. */
  ip: string;
  socket?: { remoteAddress?: string | undefined } | undefined;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * The visitor's address: the one the web tier vouches for when, and only
 * when, the TCP peer is the web tier and the header holds exactly one valid
 * address; otherwise Fastify's proxy-derived address, exactly as before.
 */
export function clientAddress(request: AddressedRequest, trustedWeb: readonly Range[]): string {
  if (trustedWeb.length > 0) {
    const peer = canonical(request.socket?.remoteAddress);
    if (peer && within(peer, trustedWeb)) {
      const vouched = request.headers[CLIENT_ADDRESS_HEADER];
      const visitor = typeof vouched === 'string' ? canonical(vouched) : null;
      if (visitor) return visitor.toString();
    }
  }
  return request.ip;
}

/**
 * The rate-limit bucket an address counts against. IPv4 by address; IPv6 by
 * its /64, because one household or one phone is handed a whole /64 and can
 * take a fresh address from it for every request, which would make a
 * per-address IPv6 bucket no limit at all. IPv4-mapped IPv6 counts as the
 * IPv4 address it carries. Anything unparseable keeps its own key.
 */
export function rateLimitKey(address: string): string {
  const parsed = canonical(address);
  if (!parsed) return `raw:${address}`;
  if (parsed.kind() === 'ipv4') return `v4:${parsed.toString()}`;
  const parts = (parsed as ipaddr.IPv6).parts.slice(0, 4);
  return `v6:${parts.map((part) => part.toString(16)).join(':')}::/64`;
}
