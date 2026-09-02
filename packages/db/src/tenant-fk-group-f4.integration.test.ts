/**
 * The tenant-composite foreign keys, group F part four: API access.
 *
 * Two edges from the public API's own tables (0141, 0142 and 0143 before):
 * a key belongs to an application, and a rate-limit window belongs to a key.
 *
 * The second is the one worth stating plainly. The window IS the ceiling: one
 * row per key per minute, and the limit lives in the WHERE clause. A window
 * attached to another merchant's key spends that merchant's allowance, so the
 * weak edge was a metering fault as much as an isolation one.
 *
 * Run on the OWNER credential and outside row-level security, for the reason
 * the earlier groups give: RLS would refuse the cross-tenant write on its own,
 * so these tests would pass with no foreign keys at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client.js';
import { identity } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let owner: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  const created = createDb(urls.owner, { max: 2 });
  owner = created.db;
  close = created.close;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await truncateAll(urls);
});

interface Edge {
  readonly edge: string;
  readonly child: string;
  readonly column: string;
  readonly parent: string;
  readonly constraint: string;
}

const GROUP_F4: readonly Edge[] = [
  {
    edge: 'api_keys.application_id -> api_applications',
    child: 'api_keys',
    column: 'application_id',
    parent: 'api_applications',
    constraint: 'api_keys_application_business_fk',
  },
  {
    edge: 'api_key_rate_windows.api_key_id -> api_keys',
    child: 'api_key_rate_windows',
    column: 'api_key_id',
    parent: 'api_keys',
    constraint: 'api_key_rate_windows_key_business_fk',
  },
];

const NEW_UNIQUES = [
  { label: 'api_applications', table: 'api_applications', name: 'api_applications_business_id_ux' },
  { label: 'api_keys', table: 'api_keys', name: 'api_keys_business_id_ux' },
] as const;

describe('group F4: the keys are declared as ruling 1 asked', () => {
  it.each(GROUP_F4)(
    '$edge: a validated composite key',
    async ({ child, column, parent, constraint }) => {
      const rows = await owner.execute<{ def: string; validated: boolean }>(sql`
        SELECT pg_get_constraintdef(con.oid) AS def, con.convalidated AS validated
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
         WHERE c.relname = ${child} AND con.conname = ${constraint}
      `);
      const row = [...rows][0];
      expect(row?.def).toBe(
        `FOREIGN KEY (business_id, ${column}) REFERENCES ${parent}(business_id, id)`,
      );
      expect(row?.validated).toBe(true);
    },
  );

  it.each(GROUP_F4)('$edge: the weaker single-column key is gone', async ({ child, column }) => {
    const rows = await owner.execute<{ conname: string }>(sql`
      SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = con.conkey[1]
       WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1
         AND c.relname = ${child} AND a.attname = ${column}
    `);
    expect([...rows].map((r) => r.conname)).toEqual([]);
  });

  it.each(NEW_UNIQUES)(
    '$label gains the tenant key the edges point at',
    async ({ table, name }) => {
      const rows = await owner.execute<{ def: string }>(sql`
      SELECT pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
       WHERE c.relname = ${table} AND con.conname = ${name}
    `);
      expect([...rows][0]?.def).toBe('UNIQUE (business_id, id)');
    },
  );

  it('adds no ON DELETE action the old key did not have', async () => {
    const rows = await owner.execute<{ def: string }>(sql`
      SELECT pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
       WHERE c.relname = 'api_key_rate_windows'
         AND con.conname = 'api_key_rate_windows_key_business_fk'
    `);

    /* 0110 declared the replaced key as a plain REFERENCES with no ON DELETE
     * action. Swapping a key is a chance to change delete behaviour by
     * accident in either direction, so the absence of a cascade is asserted
     * rather than assumed: this migration replaces the tenant check and
     * nothing else. */
    expect([...rows][0]?.def).toBe(
      'FOREIGN KEY (business_id, api_key_id) REFERENCES api_keys(business_id, id)',
    );
  });
});

/** Two merchants, each with an application, a key, and a rate window. */
async function seedCast(tag: string, minute: string): Promise<Record<string, string>> {
  const user = await identity.upsertUserByPhone(owner, `+23490${tag.padStart(8, '0')}`);
  const business = await identity.createBusinessWithOwner(owner, {
    name: `Api ${tag}`,
    businessType: null,
    ownerUserId: user.id,
  });
  const b = business.id;

  const one = async (statement: ReturnType<typeof sql>): Promise<string> => {
    const rows = await owner.execute<{ id: string }>(statement);
    const id = [...rows][0]?.id;
    if (!id) throw new Error('fixture insert returned no id');
    return id;
  };

  const application = await one(sql`
    INSERT INTO api_applications (business_id, name) VALUES (${b}::uuid, ${`App ${tag}`})
    RETURNING id`);
  const key = await one(sql`
    INSERT INTO api_keys (business_id, application_id, prefix, token_hash)
    VALUES (${b}::uuid, ${application}::uuid, ${`rk_live_${tag}0000`}, ${`hash-${tag}`})
    RETURNING id`);
  /* Each merchant's window sits at a DIFFERENT minute. The primary key is
   * (api_key_id, window_start), so repointing api_key_id at the other tenant's
   * key would collide with their window if both sat at the same minute, and
   * that unique would be raised instead of the foreign key: the test would
   * pass while proving nothing about the tenant. */
  await owner.execute(sql`
    INSERT INTO api_key_rate_windows (business_id, api_key_id, window_start, calls)
    VALUES (${b}::uuid, ${key}::uuid, ${minute}::timestamptz, 1)`);

  return { businesses: b, api_applications: application, api_keys: key, window_start: minute };
}

describe('group F4: the refusal is the database’s, not the application’s', () => {
  it('a key cannot be minted under another tenant’s application', async () => {
    const mine = await seedCast('1', '2026-09-02T00:00:00Z');
    const theirs = await seedCast('2', '2026-09-02T00:01:00Z');

    /* Same tenant first: a constraint that refused everything would pass the
     * cross-tenant case and prove nothing. */
    await expect(
      owner.execute(
        sql.raw(`UPDATE api_keys SET application_id = '${mine['api_applications']}'
                  WHERE id = '${mine['api_keys']}'`),
      ),
    ).resolves.toBeDefined();

    const refusal = await owner
      .execute(
        sql.raw(`UPDATE api_keys SET application_id = '${theirs['api_applications']}'
                  WHERE id = '${mine['api_keys']}'`),
      )
      .then(
        () => null,
        (error: Error & { cause?: unknown }) => error,
      );

    expect(refusal, "accepted another tenant's application").not.toBeNull();
    expect(String(refusal?.cause)).toContain('api_keys_application_business_fk');
  });

  it('a rate window cannot be moved onto another tenant’s key', async () => {
    const mine = await seedCast('3', '2026-09-02T00:00:00Z');
    const theirs = await seedCast('4', '2026-09-02T00:01:00Z');

    /* The window IS the ceiling. Before 0144 this UPDATE succeeded, and the
     * result was one merchant's calls counted against another merchant's
     * allowance. Addressed by (api_key_id, window_start) because this table
     * has no id column. */
    const refusal = await owner
      .execute(
        sql.raw(`UPDATE api_key_rate_windows SET api_key_id = '${theirs['api_keys']}'
                  WHERE api_key_id = '${mine['api_keys']}'
                    AND window_start = '${mine['window_start']}'`),
      )
      .then(
        () => null,
        (error: Error & { cause?: unknown }) => error,
      );

    expect(refusal, "accepted another tenant's key for a rate window").not.toBeNull();
    expect(String(refusal?.cause)).toContain('api_key_rate_windows_key_business_fk');
  });

  it('a window still moves freely between this tenant’s own keys', async () => {
    const mine = await seedCast('5', '2026-09-02T00:00:00Z');
    const second = await owner.execute<{ id: string }>(sql`
      INSERT INTO api_keys (business_id, application_id, prefix, token_hash)
      VALUES (${mine['businesses']}::uuid, ${mine['api_applications']}::uuid,
              'rk_live_50000001', 'hash-5b')
      RETURNING id`);
    const other = [...second][0]?.id;
    if (!other) throw new Error('fixture: second key missing');

    /* The constraint is about the tenant, not about immobility. */
    await expect(
      owner.execute(
        sql.raw(`UPDATE api_key_rate_windows SET api_key_id = '${other}'
                  WHERE api_key_id = '${mine['api_keys']}'
                    AND window_start = '${mine['window_start']}'`),
      ),
    ).resolves.toBeDefined();
  });
});
