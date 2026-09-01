/**
 * The tenant-composite foreign keys, group E: the platform edge
 * (ruling 1; A is 0132, B is 0133, C is 0134, D is 0135).
 *
 * `waba_catalogue_items` is group C's worked example again, one layer out.
 * The table has carried the composite key for `product_id` since it was
 * created and the single-column key for `waba_connection_id` beside it. The
 * consequence is worse here than for an ordinary child row: the connection is
 * the WhatsApp Business Account a catalogue sync writes INTO, so a row naming
 * another merchant's connection names another merchant's storefront.
 *
 * Group E's other two relationships, both on `platform_cost_events`, are not
 * here. They are held for a separate decision, recorded in migration 0138.
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

describe('group E: the key is declared as the ruling asked', () => {
  it('waba_catalogue_items.waba_connection_id: a validated composite key', async () => {
    const rows = await owner.execute<{ def: string; validated: boolean }>(sql`
      SELECT pg_get_constraintdef(con.oid) AS def, con.convalidated AS validated
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
       WHERE c.relname = 'waba_catalogue_items'
         AND con.conname = 'waba_catalogue_items_connection_business_fk'
    `);
    const row = [...rows][0];
    expect(row?.def).toBe(
      'FOREIGN KEY (business_id, waba_connection_id) REFERENCES waba_connections(business_id, id)',
    );
    expect(row?.validated).toBe(true);
  });

  it('leaves waba_catalogue_items with both of its edges in the same shape', async () => {
    const rows = await owner.execute<{ def: string }>(sql`
      SELECT pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
       WHERE c.relname = 'waba_catalogue_items' AND con.contype = 'f'
         AND con.confrelid <> 'businesses'::regclass
       ORDER BY con.conname
    `);

    /* Listed rather than counted, so a future edge on this table has to be
     * looked at rather than silently absorbed. */
    expect([...rows].map((r) => r.def)).toEqual([
      'FOREIGN KEY (business_id, waba_connection_id) REFERENCES waba_connections(business_id, id)',
      'FOREIGN KEY (business_id, product_id) REFERENCES products(business_id, id)',
    ]);
  });

  it('platform_cost_events is untouched, pending its own decision', async () => {
    const rows = await owner.execute<{ conname: string }>(sql`
      SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
       WHERE c.relname = 'platform_cost_events' AND con.contype = 'f'
         AND array_length(con.conkey, 1) = 2
    `);

    /* MATCH FULL, the shape first proposed for this table, rejects any row
     * mixing null and non-null key values, which is the (tenant present,
     * payment absent) shape every unattributed cost row already has. Asserted
     * so the gap is a recorded decision rather than something overlooked. */
    expect([...rows].map((r) => r.conname)).toEqual([]);
  });
});

/** One business with a connection and a product, written raw. */
async function seedCast(tag: string): Promise<Record<string, string>> {
  const user = await identity.upsertUserByPhone(owner, `+23485${tag.padStart(8, '0')}`);
  const business = await identity.createBusinessWithOwner(owner, {
    name: `Catalogue ${tag}`,
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
    INSERT INTO waba_connections (business_id, waba_id, phone_number_id, display_phone, status)
    VALUES (${b}::uuid, ${`waba-${tag}`}, ${`pn-${tag}`}, ${`+2348500000${tag}`}, 'CONNECTED')
    RETURNING id`);
  const product = await one(sql`
    INSERT INTO products (business_id, name) VALUES (${b}::uuid, ${`Product E ${tag}`})
    RETURNING id`);
  const item = await one(sql`
    INSERT INTO waba_catalogue_items (business_id, waba_connection_id, product_id, retailer_id,
                                      synced_name, synced_price_k, synced_availability, status)
    VALUES (${b}::uuid, ${connection}::uuid, ${product}::uuid, ${product}, ${`Product E ${tag}`},
            1000, 'in stock', 'SYNCED')
    RETURNING id`);

  return { waba_connections: connection, products: product, waba_catalogue_items: item };
}

describe('group E: the refusal is the database’s, not the application’s', () => {
  it('a catalogue item cannot be repointed at another tenant’s connection', async () => {
    const mine = await seedCast('1');
    const theirs = await seedCast('2');

    /* Same tenant first: a constraint that refused everything would pass the
     * cross-tenant case and prove nothing. */
    await expect(
      owner.execute(
        sql.raw(`UPDATE waba_catalogue_items
                    SET waba_connection_id = '${mine['waba_connections']}'
                  WHERE id = '${mine['waba_catalogue_items']}'`),
      ),
    ).resolves.toBeDefined();

    const refusal = await owner
      .execute(
        sql.raw(`UPDATE waba_catalogue_items
                    SET waba_connection_id = '${theirs['waba_connections']}'
                  WHERE id = '${mine['waba_catalogue_items']}'`),
      )
      .then(
        () => null,
        (error: Error & { cause?: unknown }) => error,
      );

    expect(refusal, "accepted another tenant's connection").not.toBeNull();
    expect(String(refusal?.cause)).toContain('waba_catalogue_items_connection_business_fk');
  });
});
