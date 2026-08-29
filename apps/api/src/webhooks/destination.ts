/**
 * Where a merchant's webhook is allowed to point (PR-134).
 *
 * The estate makes exactly one outbound request to an address a merchant
 * chose (`sender.ts`), which makes that request the platform's server-side
 * request-forgery surface. Until now the only rules were "https", "do not
 * follow redirects" and a ten-second timeout. Those are real, and none of
 * them stops `https://169.254.169.254/latest/meta-data/`, an https listener
 * on `127.0.0.1`, or a hostname whose A record simply points inside.
 *
 * Two things make this hard to get right, and both are handled here rather
 * than at the call site:
 *
 *   THE NAME IS NOT THE DESTINATION. Checking a hostname at registration
 *   proves nothing about where the socket goes days later: DNS answers can
 *   change between the check and the connection (rebinding), and this
 *   sender retries a delivery six times across roughly a day and a half.
 *   So the authority here is `publicOnlyLookup`, which runs INSIDE the
 *   connection attempt — every address the resolver hands back is checked,
 *   and the socket can only use an address that passed.
 *
 *   ADDRESS FAMILIES LIE TO YOU. `::ffff:127.0.0.1` is loopback wearing an
 *   IPv6 coat; 6to4, Teredo and NAT64 addresses each carry an IPv4
 *   destination inside an IPv6 one. Rather than hand-roll that arithmetic,
 *   classification is delegated to `ipaddr.js` (already resolved in the
 *   lockfile), and the rule is an ALLOWLIST: an address must classify as
 *   ordinary global unicast, and an IPv4-mapped address must unwrap to one
 *   too. Everything else - loopback, private, link-local (which is where
 *   the cloud metadata services live), carrier-grade NAT, unique-local
 *   (where the AWS IPv6 metadata address `fd00:ec2::254` sits), multicast,
 *   broadcast, unspecified, reserved, documentation, benchmark, discard,
 *   and the three tunnel families - is refused by not being on the list.
 *
 * Refusals never name the address they refused. A merchant learns their
 * endpoint is not publicly reachable; they do not get a probe that reports
 * which internal address answered, because that would rebuild the very
 * network-mapping oracle this file exists to close.
 */
import { lookup as dnsLookup, type LookupOptions } from 'node:dns';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

/** What a merchant is told, on every refusal, whatever the real reason. */
export const NOT_PUBLIC =
  'the endpoint must be a public https address; this one is not publicly reachable';

export class WebhookDestinationRefused extends Error {
  override readonly name = 'WebhookDestinationRefused';
  constructor(message = NOT_PUBLIC) {
    super(message);
  }
}

/**
 * The one address class Rekoda will deliver to.
 *
 * `unicast` is ipaddr.js's name for an ordinary globally-routable address.
 * Naming what is ALLOWED rather than what is blocked is deliberate: a new
 * reserved range added to the internet in five years is refused by this
 * code without anybody editing it.
 */
export function isPubliclyRoutable(address: string): boolean {
  if (isIP(address) === 0) return false;
  let parsed;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return false;
  }

  /* An IPv4 address in IPv6 clothing is judged as the IPv4 address it is,
   * which is what stops `::ffff:127.0.0.1` walking through an IPv6 door. */
  if (parsed.kind() === 'ipv6') {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) return v6.toIPv4Address().range() === 'unicast';
  }
  return parsed.range() === 'unicast';
}

/**
 * The syntactic half, run when an endpoint is REGISTERED.
 *
 * Deliberately does not resolve anything: a name that resolves today and
 * not in an hour would make registration flaky for a reason that has
 * nothing to do with the merchant, and the resolution-time check below is
 * the one that actually holds. What this catches is the class of URL that
 * can never be right - a literal internal address, a bare hostname with no
 * public domain, credentials smuggled in the userinfo - so the merchant is
 * told at the moment they can still fix it rather than by a delivery log
 * an hour later.
 */
export function refusalForUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'the endpoint must be a valid URL';
  }
  if (url.protocol !== 'https:') return 'the endpoint must be https';
  /* `https://user:pass@host/` is a way to smuggle credentials into a log
   * and, in some clients, to confuse which host is really being reached. */
  if (url.username !== '' || url.password !== '') {
    return 'the endpoint must not carry a username or password in the URL';
  }

  const host = url.hostname.replace(/^\[|]$/g, '');
  if (isIP(host) !== 0) {
    return isPubliclyRoutable(host) ? null : NOT_PUBLIC;
  }
  /* No dot means no public domain: `localhost`, `intranet`, a container
   * name on a shared network. A real callback host always has one. */
  if (!host.includes('.')) return NOT_PUBLIC;
  if (/\.(localhost|local|internal|home|lan|intranet)$/i.test(host)) return NOT_PUBLIC;
  return null;
}

/** Throwing form of {@link refusalForUrl}, for the registration path. */
export function assertRegistrableUrl(raw: string): void {
  const refusal = refusalForUrl(raw);
  if (refusal) throw new WebhookDestinationRefused(refusal);
}

type LookupAll = { address: string; family: number };
/* Node's own `LookupFunction` shape, spelled out so this stays assignable
 * to what `https.request` expects under `exactOptionalPropertyTypes`. */
type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAll[],
  family?: number,
) => void;

/**
 * The authority: a `lookup` for `https.request` that refuses to hand the
 * socket an address Rekoda will not talk to.
 *
 * This runs at CONNECT time, once per attempt, which is what makes it
 * rebinding-proof: there is no window between the check and the connection
 * for an answer to change, because the address the connection uses is the
 * address this function returned. A name that resolves to a mix of public
 * and internal addresses keeps only the public ones; a name that resolves
 * to nothing acceptable fails the attempt.
 */
export function publicOnlyLookup(
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
): void {
  const wantsAll = options.all === true;
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      callback(error, '', undefined);
      return;
    }
    const allowed = addresses.filter((entry) => isPubliclyRoutable(entry.address));
    if (allowed.length === 0) {
      /* ENOTFOUND rather than a bespoke code: it travels the same path as
       * any other resolution failure, and the message says what the
       * merchant can act on without naming what answered. */
      const refused: NodeJS.ErrnoException = new WebhookDestinationRefused();
      refused.code = 'ENOTFOUND';
      callback(refused, '', undefined);
      return;
    }
    if (wantsAll) {
      callback(null, allowed);
      return;
    }
    callback(null, allowed[0]!.address, allowed[0]!.family);
  });
}
