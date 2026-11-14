/**
 * The migrate job's second half against a real PostgreSQL (G-01): all four
 * runtime roles (OD-37 added the settlement and billing-operator principals) end up holding a SCRAM verifier, the job is idempotent, and
 * nothing is sent when a URL is wrong. The CI cluster authenticates by
 * trust, so logging in WITH the password is proved by the deployment job
 * instead (scripts/deploy-smoke.sh), where Postgres checks SCRAM.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { migrate, requireUrls, type Urls } from '../testing.js';
import { provisionRuntimeRoles } from '../provision.js';

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
    WHERE rolname IN ('rekoda_app', 'rekoda_worker', 'rekoda_settlement', 'rekoda_billing_operator')
    ORDER BY rolname`;
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
  await owner`ALTER ROLE rekoda_settlement PASSWORD NULL`;
  await owner`ALTER ROLE rekoda_billing_operator PASSWORD NULL`;
  await owner.end();
});

describe('provisionRuntimeRoles', () => {
  const appPw = 'a'.repeat(32);
  const workerPw = 'b'.repeat(32);
  const settlementPw = 'd'.repeat(32);
  const operatorPw = 'e'.repeat(32);
  const runtime = () => ({
    app: withRole(urls.owner, 'rekoda_app', appPw),
    worker: withRole(urls.owner, 'rekoda_worker', workerPw),
    settlement: withRole(urls.owner, 'rekoda_settlement', settlementPw),
    operator: withRole(urls.owner, 'rekoda_billing_operator', operatorPw),
  });

  it('gives all four runtime roles a SCRAM verifier, never a plaintext password', async () => {
    expect(await provisionRuntimeRoles(urls.owner, runtime())).toEqual([
      'rekoda_app',
      'rekoda_worker',
      'rekoda_settlement',
      'rekoda_billing_operator',
    ]);
    const stored = await verifiers();
    for (const role of [
      'rekoda_app',
      'rekoda_worker',
      'rekoda_settlement',
      'rekoda_billing_operator',
    ]) {
      expect(stored[role]).toMatch(/^SCRAM-SHA-256\$4096:/);
    }
    for (const pw of [appPw, workerPw, settlementPw, operatorPw]) {
      expect(JSON.stringify(stored)).not.toContain(pw);
    }
  });

  it('refuses two principals sharing one password, before sending anything', async () => {
    const before = await verifiers();
    await expect(
      provisionRuntimeRoles(urls.owner, {
        ...runtime(),
        settlement: withRole(urls.owner, 'rekoda_settlement', appPw),
      }),
    ).rejects.toThrow(/each carry a different password/);
    expect(await verifiers()).toEqual(before);
  });

  it('changes nothing when the settlement or operator URL names another role', async () => {
    const before = await verifiers();
    await expect(
      provisionRuntimeRoles(urls.owner, {
        ...runtime(),
        settlement: withRole(urls.owner, 'rekoda_app', settlementPw),
      }),
    ).rejects.toThrow(/must connect as rekoda_settlement/);
    await expect(
      provisionRuntimeRoles(urls.owner, {
        ...runtime(),
        operator: withRole(urls.owner, 'rekoda_app', operatorPw),
      }),
    ).rejects.toThrow(/must connect as rekoda_billing_operator/);
    expect(await verifiers()).toEqual(before);
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
          ...runtime(),
          app: withRole(urls.owner, 'rekoda_app', 'c'.repeat(32)),
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
