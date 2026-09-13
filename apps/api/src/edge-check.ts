/**
 * The edge-check job (G-74, G-75): docker-compose.prod.yml runs
 * `node dist/edge-check.js` in the app image, and Caddy waits for it to exit
 * 0 before it serves.
 *
 * It runs unconditionally, with no "am I the entry point?" test. Such a test
 * that ever stopped matching (a symlinked path, a renamed file) would leave
 * the job exiting 0 having checked nothing, and Caddy would take that as a
 * pass. Nothing imports this file; the rule lives in edge-proxies.ts.
 */
import { parseEdgeProxies } from './client-address.js';
import { edgeProxyProblem } from './edge-proxies.js';

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
