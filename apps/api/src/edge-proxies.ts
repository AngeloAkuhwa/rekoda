/**
 * The proxies in front of Caddy, checked before Caddy serves (G-74, G-75).
 *
 * REKODA_EDGE_PROXIES is the one client-address trust list no Rekoda process
 * reads: Caddy takes it straight from the environment
 * (`trusted_proxies static {$REKODA_EDGE_PROXIES}`), so the boot rules that
 * refuse an unsafe REKODA_TRUSTED_PROXIES or REKODA_TRUSTED_WEB in the api
 * and the worker (G-72) never see it. Set to 0.0.0.0/0 it would make Caddy
 * believe any browser's CF-Connecting-IP or X-Forwarded-For and pass that
 * address on as the visitor, which is the forged-address hole G-43 and G-71
 * close, reopened in front of them.
 *
 * So the compose file runs a one-shot job (edge-check.ts) that Caddy waits
 * for: a bad value fails the deployment instead of serving with it. The
 * universal rule and the parser are the ones G-72 already uses; only the
 * spelling differs, because Caddy's list is space-separated. The gateway
 * rule is Caddy's alone, because Caddy alone publishes a port.
 */
import ipaddr from 'ipaddr.js';
import { parseEdgeProxies, universalProblem } from './client-address.js';

/**
 * The edge network's gateway, pinned in docker-compose.prod.yml (a test holds
 * the two together). Caddy publishes its ports and the edge network is IPv4
 * only, so Docker hands Caddy every connection it proxies from this address:
 * every IPv6 visitor, and any caller that reaches the host's own address from
 * the host or another container. Trusting it would let any of them name its
 * own address in CF-Connecting-IP (G-75).
 */
export const EDGE_GATEWAY = '172.30.10.1';
const GATEWAY = ipaddr.parse(EDGE_GATEWAY);

/** Why this value must not reach Caddy, or null when it is safe. */
export function edgeProxyProblem(raw: string | undefined): string | null {
  try {
    const { ranges } = parseEdgeProxies(raw);
    const universal = universalProblem('REKODA_EDGE_PROXIES', ranges);
    if (universal) return universal;
    /* Mapped forms were folded to IPv4 by the parser, so the gateway can
     * only hide in an IPv4 range. */
    const gateway = ranges.find(
      ([base, bits]) => base.kind() === GATEWAY.kind() && GATEWAY.match(base, bits),
    );
    if (gateway) {
      return (
        `REKODA_EDGE_PROXIES trusts ${gateway[0].toString()}/${gateway[1]}, which holds the edge ` +
        `network's gateway (${EDGE_GATEWAY}). Docker hands Caddy every IPv6 visitor and every ` +
        'hairpin connection from that address, so any of them could claim to be any visitor. ' +
        "Name the actual proxy addresses or CIDRs (Cloudflare's published ranges), or leave it " +
        'empty.'
      );
    }
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}
