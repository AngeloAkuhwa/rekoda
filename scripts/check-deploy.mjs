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
  return d?.[dep] ? (d[dep].condition ?? 'service_started') : null;
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
  const caddyAddress = Object.values(svc('caddy')?.networks ?? {})
    .map((n) => n?.ipv4_address)
    .find(Boolean);
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
    const target = s?.build?.target;
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

  // No access log: query strings carry sign-in links and the webhook verify token.
  const caddyCode = caddyfile
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)#.*$/, '$1'))
    .join('\n');
  if (/(^|\s)log(\s|\{|$)/m.test(caddyCode)) {
    problems.push(`${FILES.caddyfile} enables a log; access lines would record sign-in tokens`);
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
