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
import ipaddr from 'ipaddr.js';

/** The one header the web tier uses to say which visitor it is calling for. */
export const CLIENT_ADDRESS_HEADER = 'x-rekoda-client-ip';

type Range = [ipaddr.IPv4 | ipaddr.IPv6, number];

/**
 * The web tier's addresses or CIDRs, comma-separated. Anything that does not
 * parse refuses to boot: a trust list that silently drops an entry is a trust
 * list that silently changes who is believed.
 */
export function parseTrustedWeb(raw: string | undefined): Range[] {
  const entries = (raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return entries.map((entry) => {
    try {
      if (entry.includes('/')) return ipaddr.parseCIDR(entry) as Range;
      const address = ipaddr.process(entry);
      return [address, address.kind() === 'ipv4' ? 32 : 128] as Range;
    } catch {
      throw new Error(`REKODA_TRUSTED_WEB has an entry that is not an address or CIDR: ${entry}`);
    }
  });
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
