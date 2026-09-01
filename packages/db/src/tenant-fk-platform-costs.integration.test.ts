/**
 * Group E's remainder: the platform-cost subledger (migration 0140).
 *
 * This table is not an ordinary tenant table, and that is the whole finding.
 * `business_id` is NULLABLE by design (0107: "some costs are not attributable
 * to one merchant"), so a composite key alone does not carry the guarantee the
 * other groups get for free.
 *
 * MATCH FULL cannot be used: it rejects any row mixing null and non-null key
 * values, which is every cost attributed to a merchant but not to one payment.
 * MATCH SIMPLE alone is not enough either: it skips the check when EITHER
 * column is null, so a row could name another merchant's payment while
 * claiming to be unattributed. The pair below is what closes that.
 *
 * Run on the OWNER credential, as the other groups are. This table has no RLS
 * at all (0107), so nothing but these constraints stands between the margin
 * model and a mis-attributed cost.
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
  readonly column: string;
  readonly parent: string;
  readonly fk: string;
  readonly ck: string;
}

const GROUP_E: readonly Edge[] = [
  {
    edge: 'platform_cost_events.payment_id -> payments',
    column: 'payment_id',
    parent: 'payments',
    fk: 'platform_cost_events_payment_business_fk',
    ck: 'platform_cost_events_payment_attributed_ck',
  },
  {
    edge: 'platform_cost_events.settlement_id -> settlements',
    column: 'settlement_id',
    parent: 'settlements',
    fk: 'platform_cost_events_settlement_business_fk',
    ck: 'platform_cost_events_settlement_attributed_ck',
  },
  {
    edge: 'platform_cost_events.payment_connection_id -> payment_connections',
    column: 'payment_connection_id',
    parent: 'payment_connections',
    fk: 'platform_cost_events_connection_business_fk',
    ck: 'platform_cost_events_connection_attributed_ck',
  },
];

const def = async (name: string): Promise<{ def: string; validated: boolean } | undefined> => {
  const rows = await owner.execute<{ def: string; validated: boolean }>(sql`
    SELECT pg_get_constraintdef(con.oid) AS def, con.convalidated AS validated
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname = 'platform_cost_events' AND con.conname = ${name}
  `);
  return [...rows][0];
};

describe('group E: the keys are declared as the ruling asked, adapted to a nullable tenant', () => {
  it.each(GROUP_E)('$edge: a validated composite key', async ({ column, parent, fk }) => {
    const row = await def(fk);
    expect(row?.def).toBe(
      `FOREIGN KEY (business_id, ${column}) REFERENCES ${parent}(business_id, id)`,
    );
    expect(row?.validated).toBe(true);
  });

  it.each(GROUP_E)('$edge: a CHECK closes what MATCH SIMPLE skips', async ({ column, ck }) => {
    /* Without this, (business_id NULL, <column> set) is not checked by the
     * foreign key at all, because MATCH SIMPLE skips a partially null key. */
    expect((await def(ck))?.def).toBe(
      `CHECK (((${column} IS NULL) OR (business_id IS NOT NULL)))`,
    );
  });

  it.each(GROUP_E)('$edge: the weaker single-column key is gone', async ({ column }) => {
    const rows = await owner.execute<{ conname: string }>(sql`
      SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = con.conkey[1]
       WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1
         AND c.relname = 'platform_cost_events' AND a.attname = ${column}
    `);
    expect([...rows].map((r) => r.conname)).toEqual([]);
  });

  it('leaves cost_schedule_id single-column, because it has no tenant to carry', async () => {
    const rows = await owner.execute<{ def: string }>(sql`
      SELECT pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
       WHERE c.relname = 'platform_cost_events' AND con.contype = 'f'
         AND con.confrelid = 'provider_cost_schedules'::regclass
    `);

    /* `provider_cost_schedules` has no business_id: it is platform reference
     * data. A single-column key is the complete and correct statement about
     * it, so this asserts the exclusion rather than leaving it to inference. */
    expect([...rows].map((r) => r.def)).toEqual([
      'FOREIGN KEY (cost_schedule_id) REFERENCES provider_cost_schedules(id)',
    ]);
  });
});

/** One merchant with a payment, a settlement and a connection to point at. */
async function seedCast(tag: string): Promise<Record<string, string>> {
  const user = await identity.upsertUserByPhone(owner, `+23486${tag.padStart(8, '0')}`);
  const business = await identity.createBusinessWithOwner(owner, {
    name: `Cost ${tag}`,
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

  const connection = await one(sql`
    INSERT INTO payment_connections (business_id, provider_type, status)
    VALUES (${b}::uuid, ${`prov-${tag}`}, 'active') RETURNING id`);
  const payment = await one(sql`
    INSERT INTO payments (business_id, amount_k, method, source_type)
    VALUES (${b}::uuid, 1000, 'transfer', 'chat') RETURNING id`);
  const settlement = await one(sql`
    INSERT INTO settlements (business_id, payment_connection_id, provider_settlement_id,
                             status, currency, gross_k, net_k)
    VALUES (${b}::uuid, ${connection}::uuid, ${`stl-${tag}`}, 'SETTLED', 'NGN', 1000, 900)
    RETURNING id`);

  return {
    businesses: b,
    payments: payment,
    settlements: settlement,
    payment_connections: connection,
  };
}

/** A cost row, written raw so no repository is in the way. */
const cost = (businessId: string | null, column: string | null, value: string | null, ref: string) =>
  sql.raw(`INSERT INTO platform_cost_events
             (provider, provider_product, cost_type, amount_minor, currency,
              external_reference, incurred_at, source, actual_or_estimated
              ${businessId ? ', business_id' : ''}${column ? `, ${column}` : ''})
           VALUES ('meta', 'whatsapp', 'MESSAGING', 100, 'NGN', '${ref}', now(),
                   'PROVIDER_API', 'ACTUAL'
                   ${businessId ? `, '${businessId}'` : ''}${value ? `, '${value}'` : ''})`);

const refusalFor = (statement: ReturnType<typeof sql.raw>) =>
  owner.execute(statement).then(
    () => null,
    (error: Error & { cause?: unknown }) => error,
  );

describe('group E: a cost cannot be attributed to the wrong merchant', () => {
  it.each(GROUP_E)('$edge: refuses another tenant’s row', async ({ column, parent, fk }) => {
    const mine = await seedCast('1');
    const theirs = await seedCast('2');

    /* Same tenant first: a constraint that refused everything would pass the
     * cross-tenant case and prove nothing. */
    await expect(
      owner.execute(cost(mine['businesses']!, column, mine[parent]!, `own-${column}`)),
    ).resolves.toBeDefined();

    const refusal = await refusalFor(
      cost(mine['businesses']!, column, theirs[parent]!, `cross-${column}`),
    );
    expect(refusal, `accepted another tenant's ${parent}`).not.toBeNull();
    expect(String(refusal?.cause)).toContain(fk);
  });

  it.each(GROUP_E)(
    '$edge: refuses to name a row while claiming to be unattributed',
    async ({ column, parent, ck }) => {
      const theirs = await seedCast('3');

      /* The hole MATCH SIMPLE leaves. With business_id null the foreign key is
       * not checked at all, so without the CHECK this INSERT succeeds and the
       * margin model gains a cost pointing at a merchant it does not name. */
      const refusal = await refusalFor(cost(null, column, theirs[parent]!, `orphan-${column}`));
      expect(refusal, `accepted an unattributed cost naming a ${parent}`).not.toBeNull();
      expect(String(refusal?.cause)).toContain(ck);
    },
  );

  it('still accepts the two shapes the subledger depends on', async () => {
    const mine = await seedCast('4');

    /* 0107: "some costs are not attributable to one merchant (hosting, a
     * platform OTP, a global rate-limit probe)". Both of these are exactly
     * what MATCH FULL would have rejected, which is why it was not used. */
    await expect(owner.execute(cost(null, null, null, 'hosting'))).resolves.toBeDefined();
    await expect(
      owner.execute(cost(mine['businesses']!, null, null, 'attributed-no-payment')),
    ).resolves.toBeDefined();
  });
});
