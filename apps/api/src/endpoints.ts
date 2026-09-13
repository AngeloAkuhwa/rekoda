/**
 * Where production may send a request (G-72).
 *
 * Development and tests point providers at fakes on 127.0.0.1, at a model
 * server in a sibling container, at an identity provider on localhost. Each
 * of those is one copied line away from a production `.env`, where it would
 * hand a secret key or a merchant's data to whatever answers locally. So a
 * production process checks every endpoint it is configured with before it
 * starts, and refuses the ones that are not on the public internet over TLS.
 */
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

/** The hosts the provider adapters are written against. */
export const PAYSTACK_API = 'https://api.paystack.co';
export const MONO_API = 'https://api.withmono.com';

/**
 * Names that resolve to this machine, its containers or its local network,
 * never to a public host: `localhost` (RFC 6761), mDNS `.local`, the
 * private-use `.internal` (Docker's `host.docker.internal` among them),
 * `.home.arpa` (RFC 8375), and the `.lan` and `.localdomain` that home
 * routers and resolvers hand out.
 */
const LOCAL_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'home.arpa',
  'lan',
  'localdomain',
  /* Reserved by RFC 2606 and RFC 6761 and never delegated, so they resolve
   * to nothing on the internet and to whatever a local resolver says: the
   * conventional names for a mock. */
  'invalid',
  'test',
  'example',
];

/**
 * Why `value` is not a public https endpoint, or null when it is.
 *
 * The URL is read with the same parser `fetch` uses, so every alternate
 * spelling of an address (0x7f.1, 2130706433, 127.1, [::ffff:127.0.0.1],
 * percent-encoding, full-width letters, a trailing dot) is judged as the
 * address it becomes. A name that resolves to a private address through
 * public DNS cannot be caught without resolving it, which a boot check
 * should not do; the names above are the ones that are local by definition.
 */
export function nonPublicReason(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'is not a URL';
  }
  if (url.protocol !== 'https:') return 'must use https';
  if (url.username !== '' || url.password !== '') {
    return 'must not carry a user name or password';
  }
  const host = url.hostname.replace(/\.+$/, '');
  const literal = host.startsWith('[') ? host.slice(1, -1) : host;
  if (isIP(literal) !== 0) {
    const range = ipaddr.process(literal).range();
    return range === 'unicast' ? null : `is a ${range} address, not a public one`;
  }
  if (!host.includes('.')) return `names ${host}, a local or container name, not a public host`;
  const local = LOCAL_SUFFIXES.find((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  return local ? `names a .${local} host, which resolves locally, not on the internet` : null;
}
