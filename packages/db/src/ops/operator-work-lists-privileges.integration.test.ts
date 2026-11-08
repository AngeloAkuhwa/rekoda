/**
 * OD-47 / ADR 0035 Amendment 2: the database privilege facts behind the six operator work-list
 * functions, read from the catalogue and proved on live connections. Behaviour tests
 * (`operator-work-lists.integration.test.ts`) show the lists work; these show nothing a caller
 * holds can widen them: who owns the functions, who can assume which role, what each credential
 * can create, and that no cross-tenant policy exists on the table.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from '../client.js';
import { migrate, requireUrls, type Urls } from '../testing.js';

const FUNCTIONS = [
  'dead_job_ops_queue',
  'dead_job_open_for_event',
  'dead_job_is_recovering',
  'dead_job_has_record',
  'dead_job_find_for_ops',
  'blocked_renewals_ops',
];
const CREDENTIALS = ['rekoda_app', 'rekoda_worker'];

let urls: Urls;
let ownerDb: Db;
let appDb: Db;
let workerDb: Db;
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  for (const [url, set] of [
    [urls.owner, (d: Db) => (ownerDb = d)],
    [urls.app, (d: Db) => (appDb = d)],
    [urls.worker, (d: Db) => (workerDb = d)],
  ] as const) {
    const { db, close } = createDb(url, { max: 2 });
    set(db);
    closers.push(close);
  }
});
afterAll(async () => {
  for (const c of closers) await c();
});

const rows = async <T extends Record<string, unknown>>(db: Db, text: ReturnType<typeof sql>) => [
  ...(await db.execute<T>(text)),
];

async function sqlState(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.cause?.code ?? err.code;
  }
  return undefined;
}

describe('the six functions', () => {
  const list = sql.raw(FUNCTIONS.map((f) => `'${f}'`).join(','));

  it('are owned by a role that can reach every tenant, and that no credential is or can become', async () => {
    const owners = await rows<{ proname: string; owner: string; reaches: boolean }>(
      ownerDb,
      sql`SELECT p.proname, r.rolname AS owner, (r.rolsuper OR r.rolbypassrls) AS reaches
          FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
          WHERE p.proname IN (${list})`,
    );
    expect(owners).toHaveLength(6);
    for (const o of owners) {
      // The functions read tables under FORCE ROW LEVEL SECURITY: an owner that cannot bypass RLS
      // returns nothing (ADR 0035 Amendment 1, "Dependency"), so the owner must be able to.
      expect(o.reaches, o.proname).toBe(true);
      expect(CREDENTIALS, o.proname).not.toContain(o.owner);
      expect(o.owner, o.proname).not.toBe('rekoda_plan_writer');
    }
    const ownerNames = [...new Set(owners.map((o) => o.owner))];
    for (const credential of CREDENTIALS) {
      for (const owner of ownerNames) {
        const [held] = await rows<{ m: boolean; u: boolean; s: boolean }>(
          ownerDb,
          sql`SELECT pg_has_role(${credential}, ${owner}, 'MEMBER') AS m,
                     pg_has_role(${credential}, ${owner}, 'USAGE') AS u,
                     pg_has_role(${credential}, ${owner}, 'SET') AS s`,
        );
        expect(held, `${credential} -> ${owner}`).toEqual({ m: false, u: false, s: false });
      }
    }
  });

  it('are SECURITY DEFINER with a pinned search path, executable by the worker only, with no dynamic SQL and only schema-qualified tables', async () => {
    const fns = await rows<{
      proname: string;
      secdef: boolean;
      cfg: string[] | null;
      src: string;
      app: boolean;
      worker: boolean;
      pub: boolean;
    }>(
      ownerDb,
      sql`SELECT p.proname, p.prosecdef AS secdef, p.proconfig AS cfg, p.prosrc AS src,
                 has_function_privilege('rekoda_app', p.oid, 'EXECUTE') AS app,
                 has_function_privilege('rekoda_worker', p.oid, 'EXECUTE') AS worker,
                 coalesce((SELECT bool_or(a.grantee = 0) FROM aclexplode(p.proacl) a), false) AS pub
          FROM pg_proc p WHERE p.proname IN (${list})`,
    );
    expect(fns).toHaveLength(6);
    for (const f of fns) {
      expect(f, f.proname).toMatchObject({ secdef: true, app: false, worker: true, pub: false });
      expect(f.cfg, f.proname).toEqual(['search_path=pg_catalog, pg_temp']);
      expect(f.src, f.proname).not.toMatch(/\bexecute\b/i);
      const unqualified = [...f.src.matchAll(/\b(?:from|join)\s+(?!public\.)([a-z_]+)/gi)].map(
        (m) => m[1],
      );
      expect(unqualified, `${f.proname} names a table without schema`).toEqual([]);
    }
  });

  it('are executable by exactly the owner and the worker (no other grantee in the ACL)', async () => {
    const grantees = await rows<{ proname: string; grantee: string }>(
      ownerDb,
      sql`SELECT p.proname, CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
          FROM pg_proc p, aclexplode(p.proacl) a
          WHERE p.proname IN (${list}) AND a.privilege_type = 'EXECUTE'`,
    );
    for (const g of grantees) {
      expect(['rekoda_worker', 'rekoda'], `${g.proname} -> ${g.grantee}`).toContain(g.grantee);
    }
    expect(new Set(grantees.map((g) => g.proname)).size).toBe(6);
  });
});

describe('the application and worker credentials', () => {
  it('hold no elevated attribute and no role membership of any kind', async () => {
    const attrs = await rows<Record<string, boolean | string>>(
      ownerDb,
      sql`SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
          FROM pg_roles WHERE rolname IN ('rekoda_app', 'rekoda_worker') ORDER BY rolname`,
    );
    expect(attrs).toHaveLength(2);
    for (const a of attrs) {
      expect(a, String(a['rolname'])).toMatchObject({
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
      });
    }
    const memberships = await rows(
      ownerDb,
      sql`SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
          WHERE r.rolname IN ('rekoda_app', 'rekoda_worker')`,
    );
    expect(memberships).toEqual([]);
  });

  it('cannot assume the plan writer or the function owner on a live connection', async () => {
    const owner = (
      await rows<{ owner: string }>(
        ownerDb,
        sql`SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE proname = 'dead_job_ops_queue'`,
      )
    )[0]!.owner;
    for (const [name, db] of [
      ['rekoda_app', appDb],
      ['rekoda_worker', workerDb],
    ] as const) {
      for (const target of [
        'rekoda_plan_writer',
        owner,
        name === 'rekoda_app' ? 'rekoda_worker' : 'rekoda_app',
      ]) {
        expect(
          await sqlState(db.execute(sql.raw(`SET ROLE ${target}`))),
          `${name} -> ${target}`,
        ).toBe('42501');
      }
    }
  });

  it('cannot create objects in the schema the definer functions resolve against', async () => {
    for (const credential of CREDENTIALS) {
      const [p] = await rows<{ c: boolean }>(
        ownerDb,
        sql`SELECT has_schema_privilege(${credential}, 'public', 'CREATE') AS c`,
      );
      expect(p?.c, credential).toBe(false);
    }
    expect(
      await sqlState(
        workerDb.execute(
          sql`CREATE FUNCTION public.shadow() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
        ),
      ),
    ).toBe('42501');
  });
});

describe('row-level security on the dead-job table', () => {
  it('has exactly one policy, tenant-scoped, and no policy naming the worker or any other role', async () => {
    const policies = await rows<{ polname: string; roles: number[]; qual: string }>(
      ownerDb,
      sql`SELECT polname, polroles::int[] AS roles, pg_get_expr(polqual, polrelid) AS qual
          FROM pg_policy WHERE polrelid = 'dead_job_exceptions'::regclass`,
    );
    expect(policies.map((p) => p.polname)).toEqual(['tenant_isolation']);
    expect(policies[0]?.roles).toEqual([0]); // PUBLIC: every role is held to the tenant pin
    expect(policies[0]?.qual).toContain("current_setting('app.business_id'");
    const [flags] = await rows<{ rls: boolean; forced: boolean }>(
      ownerDb,
      sql`SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class
          WHERE oid = 'dead_job_exceptions'::regclass`,
    );
    expect(flags).toEqual({ rls: true, forced: true });
  });
});
