/**
 * The production deployment keeps its security shape (G-01).
 *
 * docker-compose.prod.yml, the Dockerfile and the Caddyfile encode decisions
 * that are easy to undo with one innocent-looking line: publish PostgreSQL's
 * port "to debug", mount the owner password into the API "to run a quick
 * migration", drop the USER line, bake a key into a build argument, turn on
 * an access log that records sign-in links. Each rule below is one of those
 * decisions, checked mechanically on every change the way check-boundaries
 * keeps withBusiness() the only path to the database.
 *
 * The names that cross between the code and the deployment are a separate
 * question, answered by check-env-example.mjs (rules 3 to 6). This guard is
 * about who can reach what, and as whom.
 *
 * Fixtures: check-deploy.test.mjs, run in CI before this guard.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { parseDockerfile } from './check-env-example.mjs';

export const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

export const FILES = {
  compose: 'docker-compose.prod.yml',
  dockerfile: 'Dockerfile',
  caddyfile: 'deploy/Caddyfile',
  dockerignore: '.dockerignore',
  gitignore: '.gitignore',
  nvmrc: '.nvmrc',
};

/** The only secret the compose file mounts, and the only services that may. */
export const OWNER_SECRET = 'postgres_owner_password';
export const OWNER_SECRET_HOLDERS = ['postgres', 'migrate'];
/** The services that may reach PostgreSQL, and the network they share. */
export const DB_NETWORK = 'db';
export const DB_CLIENTS = ['api', 'migrate', 'postgres', 'worker'];
/** Long-running services: restarted, and (except the proxy) health-checked. */
export const SERVING = ['api', 'caddy', 'postgres', 'web', 'worker'];
export const HEALTH_CHECKED = ['api', 'postgres', 'web', 'worker'];
/** A name that looks like a credential, which no image may be built with. */
const SECRET_SHAPED = /SECRET|PASSWORD|TOKEN|PRIVATE|PEPPER|DATABASE_URL|_KEY$/;
/** Lines .dockerignore must keep: a secret outside the context cannot reach a layer. */
export const DOCKERIGNORE_REQUIRED = [
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  'secrets/',
  '.git/',
];
/** The only services that may load .env, which holds every application secret. */
export const ENV_FILE_LOADERS = ['api', 'migrate', 'worker'];
/** The one-shot job that checks Caddy's own trust list before it serves (G-74). */
export const EDGE_CHECK = 'edge-check';
export const EDGE_PROXIES = 'REKODA_EDGE_PROXIES';
export const EDGE_CHECK_COMMAND = 'dist/edge-check.js';
/**
 * The fields the job may set: each is read by a rule below or cannot stop
 * the check running. Anything else is refused rather than trusted, because
 * compose keeps adding ways to skip a service (`scale: 0`, `deploy.replicas:
 * 0` and `provider` all make caddy's wait pass with no check at all).
 */
const EDGE_CHECK_FIELDS = new Set([
  'image',
  'pull_policy',
  'command',
  'environment',
  'network_mode',
  'restart',
  'read_only',
  'tmpfs',
  'cap_drop',
  'security_opt',
  'logging',
]);
/** The fields a rule below already refuses by name, with its own message. */
const EDGE_CHECK_REFUSED = new Set([
  'profiles',
  'extends',
  'entrypoint',
  'env_file',
  'volumes',
  'volumes_from',
  'configs',
  'secrets',
  'devices',
]);
/**
 * The edge network, exactly (G-75). The edge check refuses any trust range
 * holding its gateway (EDGE_GATEWAY in apps/api/src/edge-proxies.ts), which
 * is only this network's gateway while compose pins it and the network
 * carries no IPv6, whose gateway the check would not know.
 */
export const EDGE_NETWORK = {
  enable_ipv6: false,
  ipam: {
    config: [{ subnet: '172.30.10.0/24', gateway: '172.30.10.1', ip_range: '172.30.10.128/25' }],
  },
};
/** The worker's stop grace must outlast the longest job (seconds). */
export const WORKER_GRACE_SECONDS = 120;

const asList = (value) => (value === undefined || value === null ? [] : [value].flat());
function keyed(value) {
  if (!value) return new Map();
  if (Array.isArray(value)) {
    return new Map(
      value.map((entry) => {
        const [key, ...rest] = String(entry).split('=');
        return [key.trim(), rest.length > 0 ? rest.join('=') : null];
      }),
    );
  }
  return new Map(Object.entries(value).map(([k, v]) => [k, v === null ? null : String(v)]));
}
const networksOf = (svc) =>
  Array.isArray(svc?.networks) ? svc.networks : Object.keys(svc?.networks ?? {});
const secretsOf = (svc) => asList(svc?.secrets).map((s) => (typeof s === 'string' ? s : s?.source));
const conditionOf = (svc, dep) => {
  const d = svc?.depends_on;
  if (Array.isArray(d)) return d.includes(dep) ? 'service_started' : null;
  const entry = d?.[dep];
  if (!entry) return null;
  /* `required: false` turns a dependency that never arrives into a warning,
   * so the condition no longer gates anything: read it as no dependency. */
  if (entry.required === false) return null;
  return entry.condition ?? 'service_started';
};

export function problemsFor({ compose, dockerfile, caddyfile, dockerignore, gitignore, nvmrc }) {
  const problems = [];
  const doc = parseYaml(compose, { merge: true }) ?? {};
  const services = doc.services ?? {};
  const svc = (name) => services[name];
  for (const name of [...SERVING, 'migrate']) {
    if (!svc(name)) problems.push(`${FILES.compose} has no ${name} service`);
  }

  // Only the proxy is reachable from outside the host.
  for (const [name, s] of Object.entries(services)) {
    if (name !== 'caddy' && asList(s?.ports).length > 0) {
      problems.push(`${name} publishes a port; only caddy may (PostgreSQL above all)`);
    }
  }

  // The owner credential: mounted into postgres and the migrate job, nowhere else.
  for (const [name, s] of Object.entries(services)) {
    const holds = secretsOf(s).includes(OWNER_SECRET);
    if (holds && !OWNER_SECRET_HOLDERS.includes(name)) {
      problems.push(
        `${name} mounts ${OWNER_SECRET}; only ${OWNER_SECRET_HOLDERS.join(' and ')} may`,
      );
    }
    if (!holds && OWNER_SECRET_HOLDERS.includes(name) && s) {
      problems.push(`${name} must mount ${OWNER_SECRET}`);
    }
    const env = keyed(s?.environment);
    if (env.has('POSTGRES_PASSWORD')) {
      problems.push(`${name} sets POSTGRES_PASSWORD in plain text; use the mounted secret file`);
    }
  }
  if (doc.secrets?.[OWNER_SECRET]?.file === undefined) {
    problems.push(`${OWNER_SECRET} must be a file secret (secrets/ on the host, never committed)`);
  }
  if (!/^\/?secrets\/?$/m.test(gitignore)) {
    problems.push(`${FILES.gitignore} must ignore secrets/`);
  }

  // .env holds every application secret: the api, the worker and the migrate
  // job (which must read the runtime URLs from the same file the services do)
  // load it, and nothing else does, least of all the internet-facing proxy.
  for (const [name, s] of Object.entries(services)) {
    if (asList(s?.env_file).length > 0 && !ENV_FILE_LOADERS.includes(name)) {
      problems.push(
        `${name} loads an env_file; only ${ENV_FILE_LOADERS.slice(0, -1).join(', ')} and ${ENV_FILE_LOADERS.at(-1)} may`,
      );
    }
  }

  // Nothing reaches the host's secrets/ except through the compose secret,
  // and no service runs as root by override.
  for (const [name, s] of Object.entries(services)) {
    for (const volume of asList(s?.volumes)) {
      const source =
        typeof volume === 'string' ? volume.split(':')[0] : String(volume?.source ?? '');
      if (/(^|\/)secrets(\/|$)/.test(source)) {
        problems.push(
          `${name} mounts ${source}; the owner secret travels only as a compose secret`,
        );
      }
    }
    if (/^(?:root|0)(?::|$)/.test(String(s?.user ?? ''))) {
      problems.push(`${name} overrides its user to root`);
    }
    if (ENV_FILE_LOADERS.includes(name)) {
      const files = asList(s?.env_file).map((f) => (typeof f === 'string' ? f : f?.path));
      if (files.length > 1) problems.push(`${name} loads more than .env: ${files.join(', ')}`);
    }
  }

  // Rekoda's images are built on the host and never pulled: a registry image
  // under the same name would otherwise run in place of the checked-out code.
  for (const [name, s] of Object.entries(services)) {
    if (/^rekoda-/.test(String(s?.image ?? '')) && s?.pull_policy !== 'never') {
      problems.push(`${name} runs a Rekoda image and must set pull_policy: never`);
    }
  }

  // The worker's jobs finish before a stop kills them.
  const grace = String(svc('worker')?.stop_grace_period ?? '');
  const m = grace.match(/^(\d+)(s|m)$/);
  const graceSeconds = m ? Number(m[1]) * (m[2] === 'm' ? 60 : 1) : 0;
  if (svc('worker') && graceSeconds < WORKER_GRACE_SECONDS) {
    problems.push(
      `worker must set stop_grace_period to at least ${WORKER_GRACE_SECONDS}s (found "${grace || 'unset'}")`,
    );
  }

  // The migrate job runs only when asked, and is the only way in as the owner.
  const migrate = svc('migrate');
  if (migrate && asList(migrate.profiles).length === 0) {
    problems.push('migrate must sit behind a profile, so `up` never starts it');
  }
  for (const name of SERVING) {
    if (asList(svc(name)?.profiles).length > 0) {
      problems.push(`${name} sits behind a profile; \`up\` would not start it`);
    }
  }

  // The api and the worker: one image, two roles, runtime credentials only.
  const api = svc('api');
  const worker = svc('worker');
  if (api && worker && api.image !== worker.image) {
    problems.push('the api and the worker must run the same image');
  }
  const fixedAddress = (name) =>
    Object.values(svc(name)?.networks ?? {})
      .map((n) => n?.ipv4_address)
      .find(Boolean);
  const caddyAddress = fixedAddress('caddy');
  /* The web tier has a fixed address too, distinct from Caddy's: the API
   * believes X-Rekoda-Client-IP from that peer alone (G-71). */
  const webAddress = fixedAddress('web');
  if (!webAddress || webAddress === caddyAddress) {
    problems.push('web must have its own fixed address on the edge network');
  }
  for (const [name, role] of [
    ['api', '0'],
    ['worker', '1'],
  ]) {
    const s = svc(name);
    if (!s) continue;
    const env = keyed(s.environment);
    if (env.get('REKODA_WORKER') !== role) {
      problems.push(`${name} must set REKODA_WORKER to '${role}'`);
    }
    if (env.get('NODE_ENV') !== 'production') problems.push(`${name} must set NODE_ENV=production`);
    for (const url of ['DATABASE_URL', 'WORKER_DATABASE_URL']) {
      if (env.has(url)) {
        problems.push(`${name} overrides ${url}; the runtime roles come from .env only`);
      }
    }
    if (!asList(s.env_file).some((f) => (typeof f === 'string' ? f : f?.path) === '.env')) {
      problems.push(`${name} must load .env`);
    }
    if (!caddyAddress || env.get('REKODA_TRUSTED_PROXIES') !== caddyAddress) {
      problems.push(`${name} must trust exactly caddy's fixed address as its proxy`);
    }
    if (!webAddress || env.get('REKODA_TRUSTED_WEB') !== webAddress) {
      problems.push(`${name} must trust exactly web's fixed address to name the visitor`);
    }
  }

  // PostgreSQL's network: internal, and joined by exactly its clients.
  if (doc.networks?.[DB_NETWORK]?.internal !== true) {
    problems.push(`the ${DB_NETWORK} network must be internal (no route in or out)`);
  }
  const onDb = Object.entries(services)
    .filter(([, s]) => networksOf(s).includes(DB_NETWORK))
    .map(([name]) => name)
    .sort();
  if (onDb.join() !== [...DB_CLIENTS].sort().join()) {
    problems.push(
      `the ${DB_NETWORK} network must hold exactly ${DB_CLIENTS.join(', ')} (it holds ${onDb.join(', ') || 'nothing'})`,
    );
  }
  const pgNetworks = networksOf(svc('postgres'));
  if (pgNetworks.some((n) => n !== DB_NETWORK)) {
    problems.push(`postgres must be on the ${DB_NETWORK} network only`);
  }

  // Long-running services restart, and are health-checked where it means anything.
  for (const name of SERVING) {
    const s = svc(name);
    if (!s) continue;
    if (s.restart !== 'unless-stopped') problems.push(`${name} must restart unless-stopped`);
    if (HEALTH_CHECKED.includes(name) && !s.healthcheck?.test) {
      problems.push(`${name} must have a healthcheck`);
    }
  }
  for (const [name, dep] of [
    ['api', 'postgres'],
    ['worker', 'postgres'],
    ['migrate', 'postgres'],
    ['web', 'api'],
    ['caddy', 'api'],
    ['caddy', 'web'],
  ]) {
    if (svc(name) && conditionOf(svc(name), dep) !== 'service_healthy') {
      problems.push(`${name} must wait for ${dep} to be healthy`);
    }
  }

  /* The edge trust list is Caddy's alone: no Rekoda process reads it, so
   * the boot rules cannot refuse a universal value (G-74). A one-shot job
   * in the app image checks it, and Caddy waits for that job to succeed. */
  const edge = svc(EDGE_CHECK);
  if (!edge) {
    problems.push(
      `${FILES.compose} has no ${EDGE_CHECK} service; ${EDGE_PROXIES} would go unchecked`,
    );
  } else {
    if (edge.image !== svc('api')?.image) {
      problems.push(`${EDGE_CHECK} must run the same image as the api, which holds the check`);
    }
    const edgeEnv = keyed(edge.environment);
    if (edgeEnv.get(EDGE_PROXIES) !== `\${${EDGE_PROXIES}:-}`) {
      problems.push(`${EDGE_CHECK} must receive ${EDGE_PROXIES} exactly as caddy does`);
    }
    /* That variable and nothing else: NODE_OPTIONS can preload a module
     * (`--import=data:text/javascript,process.exit(0)`) that exits 0 before
     * the check runs, and caddy would take the exit as a pass. */
    if (edgeEnv.size !== 1) {
      problems.push(
        `${EDGE_CHECK} must receive ${EDGE_PROXIES} and nothing else; another variable can stop the check running`,
      );
    }
    if (asList(edge.profiles).length > 0) {
      problems.push(`${EDGE_CHECK} sits behind a profile; \`up\` would start caddy without it`);
    }
    /* The exact command, not a command mentioning the file: `node -e
     * 'process.exit(0)' dist/edge-check.js` would leave caddy waiting on a
     * job that checked nothing. */
    const edgeCommand = asList(edge.command).map(String);
    if (
      edgeCommand.length !== 2 ||
      edgeCommand[0] !== 'node' ||
      edgeCommand[1] !== EDGE_CHECK_COMMAND
    ) {
      problems.push(
        `${EDGE_CHECK} must run exactly \`node ${EDGE_CHECK_COMMAND}\`, the check itself`,
      );
    }
    /* An entrypoint makes the command its arguments: `entrypoint: ['true']`
     * exits 0 without reading anything, and caddy would serve. */
    /* Every rule here reads the service as written. `extends` would merge in
     * fields from elsewhere (an entrypoint, a mount) that none of them sees. */
    if (edge.extends !== undefined) {
      problems.push(`${EDGE_CHECK} must not extend another service; inherited fields go unchecked`);
    }
    if (edge.entrypoint !== undefined) {
      problems.push(`${EDGE_CHECK} must not override its entrypoint; the command is the check`);
    }
    /* A mount can replace the file the command runs
     * (`/dev/null:/repo/apps/api/dist/edge-check.js:ro` exits 0 having read
     * nothing), and read_only does not stop a bind mount. */
    /* Not tmpfs, which the job uses and which can only hide the code, never
     * substitute it: the module would be missing and the check would fail. */
    const mounts = ['volumes', 'volumes_from', 'configs', 'secrets', 'devices'].filter(
      (key) => asList(edge[key]).length > 0,
    );
    if (mounts.length > 0) {
      problems.push(
        `${EDGE_CHECK} must mount nothing (found ${mounts.join(', ')}); any mount can replace the check it runs`,
      );
    }
    /* A one-shot with no healthcheck: `up --wait` waits for it to COMPLETE
     * only because it is not expected to keep running. Left to restart, the
     * wait would hang or pass on a container that never checked anything. */
    if (String(edge.restart ?? '') !== 'no') {
      problems.push(`${EDGE_CHECK} must set restart: 'no'; it runs once, before caddy`);
    }
    /* Everything else, by allowlist (G-75): the rules above each name one
     * way round the check, and compose has more than any list of names. */
    for (const key of Object.keys(edge)) {
      if (!EDGE_CHECK_FIELDS.has(key) && !EDGE_CHECK_REFUSED.has(key)) {
        problems.push(
          `${EDGE_CHECK} must not set ${key}; a field no rule reads can stop the check running (scale: 0 and provider skip it)`,
        );
      }
    }
  }
  /* The gateway the check refuses must be the one Docker hands Caddy its
   * proxied callers from: the edge network pinned exactly, and Caddy on it
   * alone. A second network brings a second gateway, and host networking
   * none the check could name (G-75). */
  if (!isDeepStrictEqual(doc.networks?.edge, EDGE_NETWORK)) {
    problems.push(
      `the edge network must be exactly the pinned one (${JSON.stringify(EDGE_NETWORK)}); the edge check refuses its gateway and knows no other`,
    );
  }
  const caddy = svc('caddy');
  if (caddy && (caddy.network_mode !== undefined || networksOf(caddy).join() !== 'edge')) {
    problems.push(
      'caddy must join the edge network alone; the edge check knows that gateway and no other',
    );
  }
  if (conditionOf(svc('caddy'), EDGE_CHECK) !== 'service_completed_successfully') {
    problems.push(`caddy must wait for ${EDGE_CHECK} to succeed before it serves`);
  }
  if (keyed(svc('caddy')?.environment).get(EDGE_PROXIES) !== `\${${EDGE_PROXIES}:-}`) {
    problems.push(`caddy must read ${EDGE_PROXIES} from .env, the value ${EDGE_CHECK} checks`);
  }

  // Third-party images carry a version, never a moving default.
  for (const name of ['postgres', 'caddy']) {
    const image = String(svc(name)?.image ?? '');
    if (!/:\d/.test(image) || /:latest$/.test(image)) {
      problems.push(`${name} must pin an image version (found "${image}")`);
    }
  }

  // Caddy reads the committed deploy/ directory, read-only. The directory,
  // not the file: a checkout replaces the Caddyfile with a new file, which a
  // single-file bind mount never shows, so a reload would re-read stale config.
  const caddyMounts = asList(svc('caddy')?.volumes).map(String);
  if (!caddyMounts.some((v) => /^\.\/deploy:\/etc\/caddy:ro$/.test(v))) {
    problems.push(
      'caddy must mount ./deploy read-only at /etc/caddy (the directory, not the file)',
    );
  }

  // The images: Node from .nvmrc, run as a non-root user, built from no secret.
  const { globalArgs, stages } = parseDockerfile(dockerfile);
  const nodeMajor = nvmrc.trim().replace(/^v/, '').split('.')[0];
  if (globalArgs.get('NODE_VERSION') !== nodeMajor) {
    problems.push(
      `${FILES.dockerfile} NODE_VERSION is ${globalArgs.get('NODE_VERSION') ?? 'unset'}; .nvmrc says ${nodeMajor}`,
    );
  }
  for (const [name, s] of Object.entries(services)) {
    /* Every stage rule below reads THIS file, so a build that names another
     * Dockerfile, or carries one inline, is checked against the wrong one. */
    const build = s?.build;
    /* The short form is the context itself: `build: ./alternate` builds that
     * directory's Dockerfile while every stage rule reads the root one. */
    if (typeof build === 'string' && build !== '.') {
      problems.push(`${name} builds from context ${build}; only the repository root is checked`);
    }
    if (build && typeof build === 'object') {
      if (build.dockerfile !== undefined && build.dockerfile !== FILES.dockerfile) {
        problems.push(
          `${name} builds from ${build.dockerfile}; only ${FILES.dockerfile} is checked`,
        );
      }
      if (build.dockerfile_inline !== undefined) {
        problems.push(`${name} carries an inline Dockerfile, which no guard reads`);
      }
      /* The context decides which Dockerfile a bare `target` means: another
       * directory builds its own Dockerfile while this guard reads the root. */
      if (build.context !== undefined && build.context !== '.') {
        problems.push(
          `${name} builds from context ${build.context}; only the repository root is checked`,
        );
      }
    }
    const target = build?.target;
    if (!target) continue;
    const stage = stages.get(target);
    if (!stage) {
      problems.push(`${name} builds target ${target}, which ${FILES.dockerfile} does not define`);
      continue;
    }
    if (!stage.user || /^(?:root|0)(?::|$)/.test(stage.user)) {
      problems.push(`the ${target} stage must end as a non-root USER`);
    }
    if (!/^node:\$\{NODE_VERSION\}/.test(stage.base)) {
      problems.push(`the ${target} stage must start from node:\${NODE_VERSION}`);
    }
    for (const arg of keyed(s.build.args).keys()) {
      if (SECRET_SHAPED.test(arg) && !arg.startsWith('NEXT_PUBLIC_')) {
        problems.push(
          `${name} passes ${arg} as a build argument; a secret would stay in the image`,
        );
      }
    }
  }
  for (const [stageName, stage] of stages) {
    for (const name of [...stage.args.keys(), ...stage.env]) {
      if (SECRET_SHAPED.test(name) && !name.startsWith('NEXT_PUBLIC_')) {
        problems.push(`the ${stageName} stage declares ${name}; a secret would stay in the image`);
      }
      /* The image's own environment reaches every container built from it,
       * ${EDGE_CHECK} included, and NODE_OPTIONS can preload a module that
       * exits before the check runs (G-74). Giving the job one variable is
       * no use if the image hands it another. */
      if (name === 'NODE_OPTIONS') {
        problems.push(
          `the ${stageName} stage declares NODE_OPTIONS; it would preload into every container, ${EDGE_CHECK} included`,
        );
      }
    }
    /* The images run a CMD only. An image ENTRYPOINT would make every
     * command its arguments, ${EDGE_CHECK}'s included, which is the same
     * neutering the compose-level rule refuses. */
    if (stage.entrypoint) {
      problems.push(
        `the ${stageName} stage declares ENTRYPOINT; it would take over every command, ${EDGE_CHECK}'s included`,
      );
    }
  }
  const ignored = new Set(
    dockerignore
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  );
  for (const line of DOCKERIGNORE_REQUIRED) {
    if (!ignored.has(line)) problems.push(`${FILES.dockerignore} must exclude ${line}`);
  }

  // No access log: query strings carry sign-in links and the webhook verify
  // token. The one log allowed is Caddy's filtered default, which must drop
  // the request's URI and headers (proxy errors name the request).
  const caddyCode = caddyfile
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)#.*$/, '$1'))
    .join('\n');
  const logLines = caddyCode.split('\n').filter((l) => /^\s*log(\s|\{|$)/.test(l));
  if (logLines.some((l) => !/^\s*log default \{\s*$/.test(l))) {
    problems.push(`${FILES.caddyfile} enables a log; access lines would record sign-in tokens`);
  }
  /* Caddy's client address comes from the value edge-check reads (G-74):
   * a literal list here, or a different variable, would be unchecked. */
  /* The whole directive, not a substring: `trusted_proxies static
   * {$REKODA_EDGE_PROXIES} 0.0.0.0/0` would keep the variable and still
   * trust everyone, which is the likeliest way to undo this. */
  /* The three directives that decide a client's address. Each must appear
   * exactly once in the whole file, written exactly as pinned, inside the
   * address-less `servers` block that applies to every listener:
   *
   *   - trusted_proxies: from the value edge-check checks, and nothing else
   *     (a literal list, or a second directive, would be unchecked);
   *   - trusted_proxies_strict: without it Caddy takes the LEFTMOST
   *     X-Forwarded-For entry, which a browser writes and Cloudflare appends
   *     to, the forged address G-43 and G-71 close;
   *   - client_ip_headers: exactly these two. Caddy merges repeated lines, so
   *     a second line naming X-Client-IP (which Cloudflare passes through
   *     untouched) would put a browser-set header first.
   *
   * Counting across the file, not just the block, is what keeps a copy in a
   * snippet or a listener-specific block from being mistaken for the real
   * one; a quoted directive name is the same directive to Caddy. */
  const PINNED = [
    ['trusted_proxies', `trusted_proxies static {$${EDGE_PROXIES}}`],
    ['trusted_proxies_strict', 'trusted_proxies_strict'],
    ['client_ip_headers', 'client_ip_headers CF-Connecting-IP X-Forwarded-For'],
  ];
  const directive = (line) => line.trim().replace(/^"([^"\s]+)"/, '$1');
  const serversBlock = (() => {
    const found = /(?:^|\s)servers\s*\{/.exec(caddyCode);
    if (!found) return '';
    let depth = 0;
    for (let i = caddyCode.indexOf('{', found.index); i < caddyCode.length; i++) {
      if (caddyCode[i] === '{') depth += 1;
      else if (caddyCode[i] === '}' && --depth === 0) return caddyCode.slice(found.index, i + 1);
    }
    return '';
  })();
  const blockLines = serversBlock.split('\n').map(directive);
  /* An import there brings in lines this guard never reads (`import
   * unsafe.caddy` can add `trusted_proxies static 0.0.0.0/0`). The deploy
   * smoke checks what Caddy actually computes; this refuses it sooner. */
  if (blockLines.some((line) => line.split(/\s+/)[0] === 'import')) {
    problems.push(
      `${FILES.caddyfile} must not import anything into the servers block; the client address depends on what it holds`,
    );
  }
  for (const [name, pinned] of PINNED) {
    const everywhere = caddyCode
      .split('\n')
      .map(directive)
      .filter((line) => line.split(/\s+/)[0] === name);
    if (everywhere.length !== 1 || everywhere[0] !== pinned || !blockLines.includes(pinned)) {
      problems.push(
        `${FILES.caddyfile} must set \`${pinned}\` exactly once, in the servers block, and nowhere else (found ${everywhere.length}); the client address depends on it`,
      );
    }
  }
  if (!/request>uri\s+delete/.test(caddyCode) || !/request>headers\s+delete/.test(caddyCode)) {
    problems.push(`${FILES.caddyfile} must delete request>uri and request>headers from its log`);
  }
  /* The visitor header (G-71), checked on every reverse_proxy rather than
   * one site block, so a second route or a new hostname cannot skip it.
   * Every proxy to web sets it from the address decided above, so a
   * browser's own copy is replaced; every other proxy removes it, so only
   * the web tier ever delivers it to the API. */
  const blockFrom = (start) => {
    const open = caddyCode.indexOf('{', start);
    const lineEnd = caddyCode.indexOf('\n', start);
    if (open < 0 || (lineEnd >= 0 && open > lineEnd)) return '';
    let depth = 0;
    for (let i = open; i < caddyCode.length; i++) {
      if (caddyCode[i] === '{') depth += 1;
      else if (caddyCode[i] === '}' && --depth === 0) return caddyCode.slice(open, i + 1);
    }
    return caddyCode.slice(open);
  };
  for (const proxy of caddyCode.matchAll(/^[ \t]*reverse_proxy[ \t]+([^\n{]*)/gm)) {
    const upstreams = proxy[1].trim();
    const body = blockFrom(proxy.index);
    if (/(^|\s)web:/.test(upstreams)) {
      if (!/header_up\s+X-Rekoda-Client-IP\s+\{client_ip\}/i.test(body)) {
        problems.push(
          `${FILES.caddyfile}: reverse_proxy ${upstreams} must set X-Rekoda-Client-IP to {client_ip} for web`,
        );
      }
    } else if (!/header_up\s+-X-Rekoda-Client-IP\b/i.test(body)) {
      problems.push(
        `${FILES.caddyfile}: reverse_proxy ${upstreams} must remove X-Rekoda-Client-IP; only web may receive it`,
      );
    }
  }
  const proxies = (caddyCode.match(/^\s*reverse_proxy\b/gm) ?? []).length;
  const addressed = (caddyCode.match(/^\s*import client_address\b/gm) ?? []).length;
  if (proxies !== addressed) {
    problems.push(`every reverse_proxy in ${FILES.caddyfile} must import client_address`);
  }
  if (!/header_up\s+X-Forwarded-For\s+\{client_ip\}/.test(caddyCode)) {
    problems.push(
      `${FILES.caddyfile} must replace X-Forwarded-For with {client_ip}, or a forged one reaches the API`,
    );
  }
  return problems;
}

export function readFiles(root = ROOT) {
  return Object.fromEntries(
    Object.entries(FILES).map(([key, path]) => [key, readFileSync(join(root, path), 'utf8')]),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = problemsFor(readFiles());
  if (problems.length > 0) {
    console.error('Deployment shape broken:');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(
    `Deployment OK — ${FILES.compose}, ${FILES.dockerfile} and ${FILES.caddyfile} keep their shape.`,
  );
}
