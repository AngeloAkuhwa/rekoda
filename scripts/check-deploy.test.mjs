/**
 * Fixtures for the deployment-shape guard (G-01). Each case takes the real
 * deployment files, breaks one rule the way a hurried edit would, and names
 * the problem the guard must report. Run with
 * `node --test scripts/check-deploy.test.mjs` (CI does, before the guard).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { problemsFor, readFiles } from './check-deploy.mjs';

const REAL = readFiles();

function problems(edit = {}) {
  return problemsFor({ ...REAL, ...edit });
}
/** Replace `from` with `to` in one of the real files, insisting it was there. */
function edited(key, from, to) {
  assert.ok(REAL[key].includes(from), `fixture text not found in ${key}: ${from}`);
  return { [key]: REAL[key].replace(from, () => to) };
}
const expectProblem = (found, pattern) =>
  assert.ok(
    found.some((p) => pattern.test(p)),
    `expected a problem matching ${pattern}, got:\n  ${found.join('\n  ') || '(none)'}`,
  );

test('the committed deployment keeps its shape', () => {
  assert.deepEqual(problems(), []);
});

test('PostgreSQL publishing a port', () => {
  const edit = edited(
    'compose',
    '    image: postgres:16-alpine\n',
    '    image: postgres:16-alpine\n    ports:\n      - "5432:5432"\n',
  );
  expectProblem(problems(edit), /^postgres publishes a port/);
});

test('the owner secret mounted into the api', () => {
  const edit = edited(
    'compose',
    '    networks:\n      - edge\n      - db\n',
    '    secrets:\n      - postgres_owner_password\n    networks:\n      - edge\n      - db\n',
  );
  expectProblem(problems(edit), /^api mounts postgres_owner_password/);
});

test('the owner password in plain text', () => {
  const edit = edited(
    'compose',
    '      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_owner_password\n',
    '      POSTGRES_PASSWORD: hunter2\n',
  );
  expectProblem(problems(edit), /sets POSTGRES_PASSWORD in plain text/);
});

test('the migrate job started by `up`', () => {
  const edit = edited('compose', '    profiles:\n      - ops\n', '');
  expectProblem(problems(edit), /migrate must sit behind a profile/);
});

test('the api overriding its database URL', () => {
  const edit = edited(
    'compose',
    "      REKODA_WORKER: '0'\n",
    "      REKODA_WORKER: '0'\n      DATABASE_URL: postgres://rekoda_owner@postgres/rekoda\n",
  );
  expectProblem(problems(edit), /api overrides DATABASE_URL/);
});

test('the api running the worker, and the worker not', () => {
  let compose = REAL.compose.replace("REKODA_WORKER: '0'", "REKODA_WORKER: '1'");
  compose = compose.replace(
    /REKODA_WORKER: '1'(?![\s\S]*REKODA_WORKER: '1')/,
    "REKODA_WORKER: '0'",
  );
  const found = problems({ compose });
  expectProblem(found, /api must set REKODA_WORKER to '0'/);
  expectProblem(found, /worker must set REKODA_WORKER to '1'/);
});

test('the worker on a different image', () => {
  const needle = '  worker:\n    image: rekoda-app:';
  const edit = edited('compose', needle, '  worker:\n    image: rekoda-worker:');
  expectProblem(problems(edit), /same image/);
});

test('the api trusting a proxy that is not caddy', () => {
  const edit = edited(
    'compose',
    '      # believes an X-Forwarded-For from.\n      REKODA_TRUSTED_PROXIES: 172.30.10.10\n',
    '      # believes an X-Forwarded-For from.\n      REKODA_TRUSTED_PROXIES: 0.0.0.0/0\n',
  );
  expectProblem(problems(edit), /api must trust exactly caddy's fixed address/);
});

test('the database network given a route out, or web joining it', () => {
  const found = problems({
    compose: REAL.compose
      .replace('  db:\n    internal: true\n', '  db: {}\n')
      .replace(
        '    networks:\n      - edge\n    depends_on:\n      api:',
        '    networks:\n      - edge\n      - db\n    depends_on:\n      api:',
      ),
  });
  expectProblem(found, /network must be internal/);
  expectProblem(found, /must hold exactly api, migrate, postgres, worker/);
});

test('a serving process that is not restarted or health-checked', () => {
  const edit = edited(
    'compose',
    '        NEXT_PUBLIC_MONO_PUBLIC_KEY: ${NEXT_PUBLIC_MONO_PUBLIC_KEY:-}\n    restart: unless-stopped\n',
    '        NEXT_PUBLIC_MONO_PUBLIC_KEY: ${NEXT_PUBLIC_MONO_PUBLIC_KEY:-}\n    restart: "no"\n',
  );
  expectProblem(problems(edit), /web must restart unless-stopped/);
});

test('web starting before the api is healthy', () => {
  const edit = edited(
    'compose',
    '    depends_on:\n      api:\n        condition: service_healthy\n    healthcheck:',
    '    depends_on:\n      api:\n        condition: service_started\n    healthcheck:',
  );
  expectProblem(problems(edit), /web must wait for api to be healthy/);
});

test('a third-party image on a moving tag', () => {
  const edit = edited('compose', 'image: caddy:2.11.4-alpine', 'image: caddy:latest');
  expectProblem(problems(edit), /caddy must pin an image version/);
});

test('an image that runs as root', () => {
  const lastUser = REAL.dockerfile.lastIndexOf('USER node');
  const dockerfile = `${REAL.dockerfile.slice(0, lastUser)}USER root${REAL.dockerfile.slice(lastUser + 'USER node'.length)}`;
  expectProblem(problems({ dockerfile }), /the web stage must end as a non-root USER/);
  const noUser = REAL.dockerfile.replace(/\nUSER node\nEXPOSE 3001/, '\nEXPOSE 3001');
  expectProblem(problems({ dockerfile: noUser }), /the app stage must end as a non-root USER/);
});

test('a Node version that is not the one in .nvmrc', () => {
  const edit = edited('dockerfile', 'ARG NODE_VERSION=24', 'ARG NODE_VERSION=22');
  expectProblem(problems(edit), /NODE_VERSION is 22; .nvmrc says 24/);
});

test('a secret as a build argument or baked with ENV', () => {
  const compose = REAL.compose.replace(
    '        NEXT_PUBLIC_MONO_PUBLIC_KEY: ${NEXT_PUBLIC_MONO_PUBLIC_KEY:-}\n',
    '        NEXT_PUBLIC_MONO_PUBLIC_KEY: ${NEXT_PUBLIC_MONO_PUBLIC_KEY:-}\n        META_APP_SECRET: ${META_APP_SECRET}\n',
  );
  const dockerfile = REAL.dockerfile.replace(
    'ARG REKODA_COMMIT=unknown\nRUN test',
    'ARG REKODA_COMMIT=unknown\nARG VAULT_KEY\nENV OTP_PEPPER=x\nRUN test',
  );
  const found = problems({ compose, dockerfile });
  expectProblem(found, /web passes META_APP_SECRET as a build argument/);
  expectProblem(found, /the app stage declares VAULT_KEY/);
  expectProblem(found, /the app stage declares OTP_PEPPER/);
  assert.ok(!found.some((p) => /NEXT_PUBLIC_MONO_PUBLIC_KEY/.test(p)), 'a public key is public');
});

test('the build context let secrets in', () => {
  const edit = edited('dockerignore', '\nsecrets/\n', '\n');
  expectProblem(problems(edit), /\.dockerignore must exclude secrets\//);
  const env = edited('dockerignore', '\n.env\n', '\n');
  expectProblem(problems(env), /\.dockerignore must exclude \.env$/);
});

test('secrets/ tracked by git', () => {
  const edit = edited('gitignore', '\nsecrets/\n', '\n');
  expectProblem(problems(edit), /\.gitignore must ignore secrets\//);
});

test('an access log at the edge, and a commented one', () => {
  const caddyfile = REAL.caddyfile.replace('\tencode zstd gzip\n', '\tlog\n\tencode zstd gzip\n');
  expectProblem(problems({ caddyfile }), /enables a log/);
  const commented = REAL.caddyfile.replace('\tencode zstd gzip\n', '\t# log\n\tencode zstd gzip\n');
  assert.deepEqual(problems({ caddyfile: commented }), []);
});

test('the edge forwarding a client-chosen X-Forwarded-For', () => {
  const edit = edited('caddyfile', '\theader_up X-Forwarded-For {client_ip}\n', '');
  expectProblem(problems(edit), /must replace X-Forwarded-For with \{client_ip\}/);
});

test('the Caddyfile mounted as a single file, which a checkout never updates', () => {
  const edit = edited(
    'compose',
    '      - ./deploy:/etc/caddy:ro\n',
    '      - ./deploy/Caddyfile:/etc/caddy/Caddyfile:ro\n',
  );
  expectProblem(problems(edit), /caddy must mount \.\/deploy read-only at \/etc\/caddy/);
});

test('.env loaded by the proxy, or a nested .env let into the build context', () => {
  const caddy = edited(
    'compose',
    '  caddy:\n    image: caddy:2.11.4-alpine\n',
    '  caddy:\n    image: caddy:2.11.4-alpine\n    env_file: .env\n',
  );
  expectProblem(problems(caddy), /^caddy loads an env_file; only api, migrate and worker may/);
  const nested = edited('dockerignore', '\n**/.env\n', '\n');
  expectProblem(problems(nested), /\.dockerignore must exclude \*\*\/\.env$/);
});

test('a worker stopped before its jobs can finish', () => {
  const edit = edited('compose', '    stop_grace_period: 150s\n', '');
  expectProblem(problems(edit), /worker must set stop_grace_period to at least 120s/);
  const short = edited('compose', '    stop_grace_period: 150s\n', '    stop_grace_period: 10s\n');
  expectProblem(problems(short), /found "10s"/);
});

test('a Rekoda image that compose may pull from a registry', () => {
  const edit = edited(
    'compose',
    '  web:\n    image: rekoda-web:${REKODA_RELEASE:?set REKODA_RELEASE in .env}\n    pull_policy: never\n',
    '  web:\n    image: rekoda-web:${REKODA_RELEASE:?set REKODA_RELEASE in .env}\n',
  );
  expectProblem(problems(edit), /^web runs a Rekoda image and must set pull_policy: never/);
});

test("Caddy's log keeping request URIs, or a proxy that skips the client address", () => {
  const unfiltered = edited('caddyfile', '\t\t\trequest>uri delete\n', '');
  expectProblem(problems(unfiltered), /must delete request>uri and request>headers from its log/);
  const bare = edited(
    'caddyfile',
    '\treverse_proxy web:3000 {\n\t\timport client_address\n\t}\n',
    '\treverse_proxy web:3000\n',
  );
  expectProblem(
    problems(bare),
    /every reverse_proxy in deploy\/Caddyfile must import client_address/,
  );
});

test('secrets/ bind-mounted, a root user by override, or a second env_file', () => {
  const mounted = edited(
    'compose',
    '    networks:\n      - edge\n      - db\n',
    '    volumes:\n      - ./secrets:/run/owner:ro\n    networks:\n      - edge\n      - db\n',
  );
  expectProblem(
    problems(mounted),
    /^api mounts \.\/secrets; the owner secret travels only as a compose secret/,
  );
  const root = edited(
    'compose',
    '  caddy:\n    image: caddy:2.11.4-alpine\n',
    '  caddy:\n    image: caddy:2.11.4-alpine\n    user: root\n',
  );
  expectProblem(problems(root), /^caddy overrides its user to root/);
  const twice = edited(
    'compose',
    '    # Requests in flight (a webhook, a report render) finish before the stop.\n    stop_grace_period: 30s\n    env_file: .env\n',
    '    # Requests in flight (a webhook, a report render) finish before the stop.\n    stop_grace_period: 30s\n    env_file:\n      - .env\n      - extra.env\n',
  );
  expectProblem(problems(twice), /^api loads more than \.env: \.env, extra\.env/);
});
