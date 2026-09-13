/**
 * The proxies in front of Caddy, checked before Caddy serves (G-74).
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
 * So the compose file runs this as a one-shot service that Caddy waits for:
 * a bad value fails the deployment instead of serving with it. The rules and
 * the parser are the ones G-72 already uses; only the spelling differs,
 * because Caddy's list is space-separated and may name `private_ranges`.
 */
import { isEntrypoint } from '@rekoda/db';
import { parseEdgeProxies, universalProblem } from './client-address.js';

/** Why this value must not reach Caddy, or null when it is safe. */
export function edgeProxyProblem(raw: string | undefined): string | null {
  try {
    return universalProblem('REKODA_EDGE_PROXIES', parseEdgeProxies(raw).ranges);
  } catch (error) {
    return (error as Error).message;
  }
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  const raw = process.env['REKODA_EDGE_PROXIES'];
  const problem = edgeProxyProblem(raw);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  const named = parseEdgeProxies(raw).entries;
  console.log(
    named.length === 0
      ? 'edge proxies: none, so Caddy believes the TCP peer alone'
      : `edge proxies: ${named.join(' ')}`,
  );
}
