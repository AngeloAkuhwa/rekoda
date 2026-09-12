/**
 * Login passwords for the two runtime roles, set by the migration role.
 *
 * The migrations create `rekoda_app` (0001) and `rekoda_worker` (0004) as
 * LOGIN roles with NO password, on purpose: a credential belongs to the
 * deployment, never to a file in the repository. On a cluster that
 * authenticates TCP connections (the production compose's Postgres does,
 * with SCRAM), a role without a password cannot log in, so something has to
 * give each role the password its connection string carries.
 *
 * This is that something, run by the deploy's migrate job right after
 * `migrate:apply` (docs/runbooks/deploy.md, G-01). The operator's `.env`
 * stays the single place the runtime passwords live: the job reads the two
 * URLs, checks each names exactly the role it is meant to, and sets that
 * role's password. Running it again sets the same passwords, so it is safe
 * on every deploy, and a rotated password takes effect by editing `.env`
 * and running the job.
 *
 * The URLs are checked before anything is sent, because the checks are
 * what keep the separation real:
 *   - each URL must connect AS its role. A `DATABASE_URL` that names the
 *     owner is the mistake that disables every tenant policy; the API's
 *     boot doctor refuses it at start, and this refuses it at deploy.
 *   - each URL must point at the same host, port and database as the
 *     migration connection, so a typo cannot provision a different cluster.
 *   - the password must be long printable ASCII. Postgres normalises a
 *     SCRAM password with SASLprep; restricting to ASCII makes that the
 *     identity, so the verifier computed here is the one the server expects.
 *
 * The server never sees the plaintext. The password is sent as a SCRAM-SHA-256
 * verifier computed here (what `psql \password` does), so a statement log on
 * the database records a salted hash, not a credential.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { isEntrypoint } from './entrypoint.js';

export const RUNTIME_ROLES = { app: 'rekoda_app', worker: 'rekoda_worker' } as const;

/** The iteration count libpq and `psql \password` use for SCRAM-SHA-256. */
const SCRAM_ITERATIONS = 4096;
/** 24 characters minimum; `openssl rand -hex 32` gives 64. */
const PASSWORD_SHAPE = /^[\x21-\x7e]{24,}$/;

export interface RuntimeCredential {
  role: string;
  password: string;
}

function parse(label: string, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} is not a URL`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${label} must be a postgres:// URL`);
  }
  return url;
}

const where = (url: URL) => `${url.hostname}:${url.port || '5432'}${url.pathname}`;

/**
 * The role and password a runtime URL carries, or a refusal naming the
 * variable. Nothing here is logged: the error messages name roles and
 * variables, never a password.
 */
export function credentialFor(
  label: string,
  raw: string,
  expectedRole: string,
  migrationUrl: string,
): RuntimeCredential {
  const url = parse(label, raw);
  const owner = parse('DATABASE_URL', migrationUrl);
  const role = decodeURIComponent(url.username);
  if (role !== expectedRole) {
    throw new Error(
      `${label} must connect as ${expectedRole}, not ${role || 'no user'}: ` +
        'the runtime roles are the only roles an application process may hold',
    );
  }
  if (where(url) !== where(owner)) {
    throw new Error(`${label} must point at the database the migrations ran against`);
  }
  const password = decodeURIComponent(url.password);
  if (!PASSWORD_SHAPE.test(password)) {
    throw new Error(
      `${label} must carry a password of at least 24 printable ASCII characters ` +
        '(generate one with: openssl rand -hex 32)',
    );
  }
  return { role, password };
}

/**
 * The SCRAM-SHA-256 verifier Postgres stores for `password`, in the form
 * `ALTER ROLE ... PASSWORD` accepts pre-hashed (RFC 5802, RFC 7677).
 */
export function scramVerifier(
  password: string,
  salt: Buffer = randomBytes(16),
  iterations = SCRAM_ITERATIONS,
): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return (
    `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}` +
    `$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
  );
}

/**
 * Give both runtime roles the passwords their URLs carry. Refuses before
 * sending anything if either URL is wrong, and refuses if the migrations
 * have not created the roles yet.
 */
export async function provisionRuntimeRoles(
  migrationUrl: string,
  urls: { app: string; worker: string },
): Promise<string[]> {
  const credentials = [
    credentialFor('APP_DATABASE_URL', urls.app, RUNTIME_ROLES.app, migrationUrl),
    credentialFor('WORKER_DATABASE_URL', urls.worker, RUNTIME_ROLES.worker, migrationUrl),
  ];
  const sql = postgres(migrationUrl, { max: 1, onnotice: () => {} });
  try {
    for (const { role, password } of credentials) {
      const found = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`;
      if (found.length === 0) {
        throw new Error(`role ${role} does not exist: run the migrations first`);
      }
      /* A utility statement takes no bind parameters. The role is one of two
       * constants and the verifier is base64, digits, `$` and `:`, so the
       * literal cannot be broken out of; the check below keeps it that way. */
      const verifier = scramVerifier(password);
      if (!/^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(verifier)) {
        throw new Error('refusing a malformed SCRAM verifier');
      }
      await sql.unsafe(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${verifier}'`);
    }
  } finally {
    await sql.end();
  }
  return credentials.map((c) => c.role);
}

/* Runnable directly: `node dist/provision.js` (the deploy's migrate job). */
if (isEntrypoint(import.meta.url, process.argv[1])) {
  const migrationUrl = process.env['DATABASE_URL'];
  const app = process.env['APP_DATABASE_URL'];
  const worker = process.env['WORKER_DATABASE_URL'];
  if (!migrationUrl || !app || !worker) {
    console.error(
      'DATABASE_URL (the migration role), APP_DATABASE_URL and WORKER_DATABASE_URL are required',
    );
    process.exit(1);
  }
  try {
    const roles = await provisionRuntimeRoles(migrationUrl, { app, worker });
    console.log(`runtime role passwords set: ${roles.join(', ')}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'provisioning failed');
    process.exit(1);
  }
}
