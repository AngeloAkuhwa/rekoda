/**
 * The migrate job's second half against a real PostgreSQL (G-01): both
 * runtime roles end up holding a SCRAM verifier, the job is idempotent, and
 * nothing is sent when a URL is wrong. The CI cluster authenticates by
 * trust, so logging in WITH the password is proved by the deployment job
 * instead (scripts/deploy-smoke.sh), where Postgres checks SCRAM.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { migrate, requireUrls, type Urls } from './testing.js';
import { provisionRuntimeRoles } from './provision.js';

let urls: Urls;
let owner: postgres.Sql;

const withRole = (raw: string, role: string, password: string) => {
  const url = new URL(raw);
  url.username = role;
  url.password = password;
  return url.toString();
};

async function verifiers(): Promise<Record<string, string | null>> {
  const rows = await owner<{ rolname: string; rolpassword: string | null }[]>`
    SELECT rolname, rolpassword FROM pg_authid
    WHERE rolname IN ('rekoda_app', 'rekoda_worker') ORDER BY rolname`;
  return Object.fromEntries(rows.map((r) => [r.rolname, r.rolpassword]));
}

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  owner = postgres(urls.owner, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  /* Leave the roles as the migrations made them: passwordless. */
  await owner`ALTER ROLE rekoda_app PASSWORD NULL`;
  await owner`ALTER ROLE rekoda_worker PASSWORD NULL`;
  await owner.end();
});

describe('provisionRuntimeRoles', () => {
  const appPw = 'a'.repeat(32);
  const workerPw = 'b'.repeat(32);
  const runtime = () => ({
    app: withRole(urls.owner, 'rekoda_app', appPw),
    worker: withRole(urls.owner, 'rekoda_worker', workerPw),
  });

  it('gives both runtime roles a SCRAM verifier, never a plaintext password', async () => {
    expect(await provisionRuntimeRoles(urls.owner, runtime())).toEqual([
      'rekoda_app',
      'rekoda_worker',
    ]);
    const stored = await verifiers();
    expect(stored['rekoda_app']).toMatch(/^SCRAM-SHA-256\$4096:/);
    expect(stored['rekoda_worker']).toMatch(/^SCRAM-SHA-256\$4096:/);
    expect(JSON.stringify(stored)).not.toContain(appPw);
    expect(JSON.stringify(stored)).not.toContain(workerPw);
  });

  it('is safe to run on every deploy', async () => {
    await provisionRuntimeRoles(urls.owner, runtime());
    await provisionRuntimeRoles(urls.owner, runtime());
    expect((await verifiers())['rekoda_app']).toMatch(/^SCRAM-SHA-256\$/);
  });

  it('changes neither password when one role is missing', async () => {
    await provisionRuntimeRoles(urls.owner, runtime());
    const before = await verifiers();
    await owner`ALTER ROLE rekoda_worker RENAME TO rekoda_worker_absent`;
    try {
      await expect(
        provisionRuntimeRoles(urls.owner, {
          app: withRole(urls.owner, 'rekoda_app', 'c'.repeat(32)),
          worker: withRole(urls.owner, 'rekoda_worker', workerPw),
        }),
      ).rejects.toThrow(/role rekoda_worker does not exist/);
    } finally {
      await owner`ALTER ROLE rekoda_worker_absent RENAME TO rekoda_worker`;
    }
    expect((await verifiers())['rekoda_app']).toBe(before['rekoda_app']);
  });

  it('changes nothing when a runtime URL names the owner', async () => {
    const before = await verifiers();
    const ownerRole = decodeURIComponent(new URL(urls.owner).username);
    await expect(
      provisionRuntimeRoles(urls.owner, {
        ...runtime(),
        app: withRole(urls.owner, ownerRole, appPw),
      }),
    ).rejects.toThrow(/must connect as rekoda_app/);
    expect(await verifiers()).toEqual(before);
  });
});
