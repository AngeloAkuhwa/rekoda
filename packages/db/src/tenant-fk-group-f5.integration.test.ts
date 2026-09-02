/**
 * The tenant-composite foreign keys, group F part five and last: delivery and
 * reconciliation plumbing (0141 through 0144 before).
 *
 * With these three, group F closes at fourteen of fourteen and every
 * single-column foreign key from a tenant-owned child to a tenant-owned parent
 * in this schema carries the tenant.
 *
 * The webhook pair is the outbound edge of the product: a delivery names the
 * endpoint it is sent TO and the event whose payload it carries. Neither said
 * whose they were, so one merchant's business event could have been delivered
 * to another merchant's URL. That is exfiltration by plumbing rather than by
 * query, which is exactly the shape a weak key hides.
 *
 * The bank match is the reconciliation join: it asserts that a bank line and a
 * posting are the same money, and a line from another merchant makes that
 * claim across two sets of books.
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
  /** What the key it replaced declared, kept verbatim. */
  readonly onDelete: string;
}

const GROUP_F5: readonly Edge[] = [
  {
    edge: 'webhook_deliveries.endpoint_id -> webhook_endpoints',
    child: 'webhook_deliveries',
    column: 'endpoint_id',
    parent: 'webhook_endpoints',
    constraint: 'webhook_deliveries_endpoint_business_fk',
    onDelete: '',
  },
  {
    edge: 'webhook_deliveries.outbox_event_id -> outbox_events',
    child: 'webhook_deliveries',
    column: 'outbox_event_id',
    parent: 'outbox_events',
    constraint: 'webhook_deliveries_outbox_business_fk',
    onDelete: '',
  },
  {
    edge: 'bank_line_matches.line_id -> bank_statement_lines',
    child: 'bank_line_matches',
    column: 'line_id',
    parent: 'bank_statement_lines',
    constraint: 'bank_line_matches_line_business_fk',
    onDelete: ' ON DELETE CASCADE',
  },
];

const NEW_UNIQUES = [
  {
    label: 'webhook_endpoints',
    table: 'webhook_endpoints',
    name: 'webhook_endpoints_business_id_ux',
  },
  { label: 'outbox_events', table: 'outbox_events', name: 'outbox_events_business_id_ux' },
  {
    label: 'bank_statement_lines',
    table: 'bank_statement_lines',
    name: 'bank_statement_lines_business_id_ux',
  },
] as const;

describe('group F5: the keys are declared as ruling 1 asked', () => {
  it.each(GROUP_F5)(
    '$edge: a validated composite key, carrying the same ON DELETE as before',
    async ({ child, column, parent, constraint, onDelete }) => {
      const rows = await owner.execute<{ def: string; validated: boolean }>(sql`
        SELECT pg_get_constraintdef(con.oid) AS def, con.convalidated AS validated
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
         WHERE c.relname = ${child} AND con.conname = ${constraint}
      `);
      const row = [...rows][0];

      /* The ON DELETE half is asserted with the key itself. Swapping a foreign
       * key is a quiet chance to change delete behaviour in either direction,
       * and this campaign has now nearly done it both ways: 0110's webhook and
       * api keys carry no delete action, 0037's bank line carries a cascade. */
      expect(row?.def).toBe(
        `FOREIGN KEY (business_id, ${column}) REFERENCES ${parent}(business_id, id)${onDelete}`,
      );
      expect(row?.validated).toBe(true);
    },
  );

  it.each(GROUP_F5)('$edge: the weaker single-column key is gone', async ({ child, column }) => {
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

  it('closes group F: no tenant-owned child still points at a tenant-owned parent weakly', async () => {
    const rows = await owner.execute<{ edge: string }>(sql`
      SELECT c.relname || '.' || a.attname || ' -> ' || p.relname AS edge
        FROM pg_constraint k
        JOIN pg_class c ON c.oid = k.conrelid
        JOIN pg_class p ON p.oid = k.confrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.conkey[1]
       WHERE k.contype = 'f' AND array_length(k.conkey, 1) = 1 AND p.relname <> 'businesses'
         AND EXISTS (SELECT 1 FROM pg_attribute pa
                      WHERE pa.attrelid = p.oid AND pa.attname = 'business_id' AND NOT pa.attisdropped)
         AND EXISTS (SELECT 1 FROM pg_attribute ca
                      WHERE ca.attrelid = c.oid AND ca.attname = 'business_id' AND NOT ca.attisdropped)
         AND NOT EXISTS (SELECT 1 FROM pg_constraint k2
                          WHERE k2.conrelid = c.oid AND k2.contype = 'f'
                            AND array_length(k2.conkey, 1) = 2
                            AND pg_get_constraintdef(k2.oid) LIKE '%, ' || a.attname || ') REFERENCES%')
       ORDER BY 1
    `);

    /* The measurement that found group F in the first place, kept as a
     * standing assertion. Ruling 1's thirty-four were closed and this same
     * query then returned fourteen more the original audit had missed; from
     * here it must return none. A new weak edge added later fails this test
     * on the PR that adds it, rather than waiting for the next audit.
     *
     * Two DUPLICATE single-column keys survive and are excluded above by the
     * composite-exists clause: `ledger_entries.transaction_id` (ruling 5,
     * parked) and `payment_intents.payment_connection_id`. Both are harmless
     * because the composite sits beside them. */
    expect([...rows].map((r) => r.edge)).toEqual([]);
  });
});

/** Two merchants, each with an endpoint, an event, a delivery, a line and a match. */
async function seedCast(tag: string): Promise<Record<string, string>> {
  const user = await identity.upsertUserByPhone(owner, `+23491${tag.padStart(8, '0')}`);
  const business = await identity.createBusinessWithOwner(owner, {
    name: `Delivery ${tag}`,
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

  const endpoint = await one(sql`
    INSERT INTO webhook_endpoints (business_id, url, encrypted_secret)
    VALUES (${b}::uuid, ${`https://merchant-${tag}.example/hook`}, 'sealed') RETURNING id`);
  const event = await one(sql`
    INSERT INTO outbox_events (business_id, type) VALUES (${b}::uuid, 'sale.recorded')
    RETURNING id`);
  const delivery = await one(sql`
    INSERT INTO webhook_deliveries (business_id, endpoint_id, outbox_event_id, event_type)
    VALUES (${b}::uuid, ${endpoint}::uuid, ${event}::uuid, 'sale.recorded') RETURNING id`);

  const line = await one(sql`
    INSERT INTO bank_statement_lines (business_id, posted_on, amount_k, fingerprint)
    VALUES (${b}::uuid, CURRENT_DATE, 1000, ${`fp-${tag}`}) RETURNING id`);
  const transaction = await owner.transaction(async (tx) => {
    const accounts = await tx.execute<{ id: string }>(sql`
      SELECT id FROM accounts WHERE business_id = ${b}::uuid ORDER BY id LIMIT 2`);
    const [debit, credit] = [...accounts];
    if (!debit || !credit) throw new Error('fixture: business has no seeded accounts');
    const rows = await tx.execute<{ id: string }>(sql`
      INSERT INTO ledger_transactions (business_id, memo, source_type)
      VALUES (${b}::uuid, 'fixture posting', 'chat') RETURNING id`);
    const id = [...rows][0]?.id;
    if (!id) throw new Error('fixture insert returned no id');
    await tx.execute(sql`
      INSERT INTO ledger_entries (business_id, transaction_id, account_id, debit_k, credit_k,
                                  transaction_amount_minor)
      VALUES (${b}::uuid, ${id}::uuid, ${debit.id}::uuid, 1000, 0, 1000),
             (${b}::uuid, ${id}::uuid, ${credit.id}::uuid, 0, 1000, 1000)`);
    return id;
  });
  const match = await one(sql`
    INSERT INTO bank_line_matches (business_id, line_id, transaction_id, decided_by, tier)
    VALUES (${b}::uuid, ${line}::uuid, ${transaction}::uuid, 'auto', 1) RETURNING id`);

  return {
    businesses: b,
    webhook_endpoints: endpoint,
    outbox_events: event,
    webhook_deliveries: delivery,
    bank_statement_lines: line,
    bank_line_matches: match,
  };
}

describe('group F5: the refusal is the database’s, not the application’s', () => {
  it.each(GROUP_F5)(
    '$edge: cannot be repointed at another tenant’s row',
    async ({ child, column, parent, constraint }) => {
      const mine = await seedCast('1');
      const theirs = await seedCast('2');

      /* Same tenant first: a constraint that refused everything would pass the
       * cross-tenant case and prove nothing. */
      await expect(
        owner.execute(
          sql.raw(`UPDATE ${child} SET ${column} = '${mine[parent]}' WHERE id = '${mine[child]}'`),
        ),
      ).resolves.toBeDefined();

      const refusal = await owner
        .execute(
          sql.raw(
            `UPDATE ${child} SET ${column} = '${theirs[parent]}' WHERE id = '${mine[child]}'`,
          ),
        )
        .then(
          () => null,
          (error: Error & { cause?: unknown }) => error,
        );

      expect(refusal, `${child}.${column} accepted another tenant's ${parent}`).not.toBeNull();
      expect(String(refusal?.cause)).toContain(constraint);
    },
  );

  it('one merchant’s event cannot be delivered to another merchant’s URL', async () => {
    const mine = await seedCast('3');
    const theirs = await seedCast('4');

    /* The webhook edge said in the terms that matter. A delivery row IS the
     * instruction to POST a payload to a URL, so a row pairing my event with
     * their endpoint is an exfiltration waiting for the dispatcher to run. */
    const refusal = await owner
      .execute(
        sql.raw(`INSERT INTO webhook_deliveries
                   (business_id, endpoint_id, outbox_event_id, event_type)
                 VALUES ('${mine['businesses']}', '${theirs['webhook_endpoints']}',
                         '${mine['outbox_events']}', 'sale.recorded')`),
      )
      .then(
        () => null,
        (error: Error & { cause?: unknown }) => error,
      );

    expect(refusal, "accepted a delivery to another tenant's endpoint").not.toBeNull();
    expect(String(refusal?.cause)).toContain('webhook_deliveries_endpoint_business_fk');
  });

  it('deleting a bank line still takes its match with it', async () => {
    const mine = await seedCast('5');

    /* 0037 gave this edge ON DELETE CASCADE and 0145 kept it. Asserted
     * behaviourally as well as by definition, because a cascade that exists in
     * the catalogue but does not fire would be worse than either. */
    await owner.execute(
      sql.raw(`DELETE FROM bank_statement_lines WHERE id = '${mine['bank_statement_lines']}'`),
    );
    const rows = await owner.execute<{ n: number }>(
      sql.raw(`SELECT count(*)::int AS n FROM bank_line_matches
                WHERE id = '${mine['bank_line_matches']}'`),
    );
    expect([...rows][0]?.n).toBe(0);
  });
});
