import 'server-only';
import { isIP } from 'node:net';
import { headers } from 'next/headers';

/**
 * Which visitor the web tier is calling the API for (G-71).
 *
 * Browsers never reach this process directly: Caddy decides the visitor's
 * address (trusting only the edge proxies it is told to) and writes it to
 * this tier as X-Rekoda-Client-IP, replacing whatever the browser sent under
 * that name. This file reads that one header, checks it is one address, and
 * hands it on in the same header on every call to the API, which believes it
 * only because the call arrives from this tier's own address. Nothing else
 * the browser sent, X-Forwarded-For included, travels onward.
 *
 * Without it the API saw every visitor as this container, and one busy
 * dashboard spent everyone's sign-in budget.
 */
export const CLIENT_ADDRESS_HEADER = 'x-rekoda-client-ip';

/** The address Caddy wrote, if it is exactly one valid IP; otherwise null. */
export function clientAddressFrom(incoming: Pick<Headers, 'get'>): string | null {
  const value = incoming.get(CLIENT_ADDRESS_HEADER)?.trim();
  if (!value || isIP(value) === 0) return null;
  return value;
}

/**
 * The header to send the API for the request being served, or none. Reads
 * the request's headers, like every other server call here that reads a
 * cookie, so it runs only while serving a request (Next's own signals, such
 * as a page bailing out of static rendering, pass through untouched). With
 * no address (a request that did not come through Caddy) the call counts
 * against this tier's own address, as it always did.
 */
export async function clientAddressHeaders(): Promise<Record<string, string>> {
  const address = clientAddressFrom(await headers());
  return address ? { [CLIENT_ADDRESS_HEADER]: address } : {};
}
