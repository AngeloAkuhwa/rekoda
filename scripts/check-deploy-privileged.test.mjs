/**
 * Fixtures for the privileged-process rules of the deployment guard (OD-51). The operator and
 * settlement services each hold one database credential that no other service may hold. Each
 * case breaks that the way a hurried edit would and names the problem the guard must report.
 * Run with `node --test scripts/check-deploy-privileged.test.mjs` (CI does, before the guard).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRIVILEGED, problemsFor, readFiles } from './check-deploy.mjs';

const REAL = readFiles();
const problems = (edit = {}) => problemsFor({ ...REAL, ...edit });
function edited(key, from, to) {
  assert.ok(REAL[key].includes(from), `fixture text not found in ${key}: ${from}`);
  return { [key]: REAL[key].replace(from, () => to) };
}
const expectProblem = (found, pattern) =>
  assert.ok(
    found.some((p) => pattern.test(p)),
    `expected a problem matching ${pattern}, got:\n  ${found.join('\n  ') || '(none)'}`,
  );

test('the committed deployment keeps the privileged processes apart', () => {
  assert.deepEqual(problems(), []);
  assert.deepEqual(Object.keys(PRIVILEGED), ['operator', 'settlement']);
});

test('the api or the worker keeping a privileged credential from .env', () => {
  const apiOperator = edited(
    'compose',
    "      SETTLEMENT_DATABASE_URL: ''\n      OPERATOR_DATABASE_URL: ''\n",
    "      SETTLEMENT_DATABASE_URL: ''\n",
  );
  expectProblem(problems(apiOperator), /^api must set OPERATOR_DATABASE_URL to ''/);
  const workerSettlement = edited(
    'compose',
    "      OPERATOR_DATABASE_URL: ''\n      SETTLEMENT_DATABASE_URL: ''\n",
    "      OPERATOR_DATABASE_URL: ''\n",
  );
  expectProblem(problems(workerSettlement), /^worker must set SETTLEMENT_DATABASE_URL to ''/);
  const real = edited(
    'compose',
    "      OPERATOR_DATABASE_URL: ''\n      SETTLEMENT_DATABASE_URL: ''\n",
    "      OPERATOR_DATABASE_URL: ''\n      SETTLEMENT_DATABASE_URL: ${SETTLEMENT_DATABASE_URL:-}\n",
  );
  expectProblem(problems(real), /^worker must set SETTLEMENT_DATABASE_URL to ''/);
});

test('a privileged process handed the shared .env, a mount, or a variable off its list', () => {
  const envFile = edited(
    'compose',
    "    command: ['node', 'dist/settlement-main.js']\n",
    "    command: ['node', 'dist/settlement-main.js']\n    env_file: .env\n",
  );
  const found = problems(envFile);
  expectProblem(found, /^settlement must not set env_file/);
  expectProblem(found, /^settlement loads an env_file/);
  const volume = edited(
    'compose',
    "    command: ['node', 'dist/operator-main.js']\n",
    "    command: ['node', 'dist/operator-main.js']\n    volumes:\n      - ./.env:/repo/.env:ro\n",
  );
  expectProblem(problems(volume), /^operator must not set volumes/);
  const extra = edited(
    'compose',
    "      PORT: '3003'\n",
    "      PORT: '3003'\n      OPERATOR_DATABASE_URL: ${OPERATOR_DATABASE_URL:-}\n",
  );
  const widened = problems(extra);
  expectProblem(widened, /^settlement must be given exactly /);
  expectProblem(widened, /^settlement is given OPERATOR_DATABASE_URL; only operator holds/);
  const meta = edited(
    'compose',
    "      PORT: '3002'\n",
    "      PORT: '3002'\n      VAULT_KEY: ${VAULT_KEY:-}\n",
  );
  expectProblem(problems(meta), /^operator must be given exactly /);
});

test('a privileged process that could start without its credential, or as another program', () => {
  const optional = edited(
    'compose',
    '      SETTLEMENT_DATABASE_URL: ${SETTLEMENT_DATABASE_URL:?set SETTLEMENT_DATABASE_URL in .env}\n',
    '      SETTLEMENT_DATABASE_URL: ${SETTLEMENT_DATABASE_URL:-}\n',
  );
  expectProblem(problems(optional), /^settlement must require SETTLEMENT_DATABASE_URL from \.env/);
  const main = edited(
    'compose',
    "    command: ['node', 'dist/operator-main.js']\n",
    "    command: ['node', 'dist/main.js']\n",
  );
  expectProblem(problems(main), /^operator must run exactly `node dist\/operator-main\.js`/);
  const dev = edited('compose', "      PORT: '3002'\n", "      PORT: '3002'\n").compose.replace(
    "      NODE_ENV: production\n      PORT: '3002'\n",
    "      NODE_ENV: development\n      PORT: '3002'\n",
  );
  expectProblem(problems({ compose: dev }), /^operator must set NODE_ENV=production/);
});

test('settlement on the public edge, or another service on its way out', () => {
  const edge = edited(
    'compose',
    '      - db\n      - settlement-egress\n',
    '      - db\n      - edge\n      - settlement-egress\n',
  );
  expectProblem(problems(edge), /^settlement must join exactly the db and settlement-egress/);
  const shared = edited(
    'compose',
    '      - db\n      - worker-egress\n',
    '      - db\n      - worker-egress\n      - settlement-egress\n',
  );
  expectProblem(problems(shared), /settlement-egress network must hold settlement alone/);
  const published = edited(
    'compose',
    "    command: ['node', 'dist/operator-main.js']\n",
    "    command: ['node', 'dist/operator-main.js']\n    ports:\n      - '3002:3002'\n",
  );
  expectProblem(problems(published), /^operator publishes a port/);
});

test('plan changes routed anywhere but the operator process, or more routed to it', () => {
  const toApi = edited(
    'caddyfile',
    '\t\treverse_proxy operator:3002 {',
    '\t\treverse_proxy api:3001 {',
  );
  expectProblem(problems(toApi), /must route exactly .* to operator:3002/);
  const wider = edited(
    'caddyfile',
    '@operator_plane path /v1/businesses/plan /v1/businesses/plan/*',
    '@operator_plane path /v1/*',
  );
  expectProblem(problems(wider), /must route exactly .* to operator:3002/);
  const second = edited(
    'caddyfile',
    '\treverse_proxy api:3001 {',
    '\thandle /v1/ops/* {\n\t\treverse_proxy operator:3002 {\n\t\t\timport client_address\n\t\t\theader_up -X-Rekoda-Client-IP\n\t\t}\n\t}\n\treverse_proxy api:3001 {',
  );
  expectProblem(problems(second), /must route exactly .* to operator:3002/);
  const waiting = edited(
    'compose',
    '      # Never serve with an edge trust list',
    '      operator:\n        condition: service_healthy\n      # Never serve with an edge trust list',
  );
  expectProblem(problems(waiting), /caddy must not wait for operator/);
});
