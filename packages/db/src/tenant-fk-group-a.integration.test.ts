/**
 * The tenant-composite foreign keys, proved at the database (ruling 1).
 *
 * Migration 0132 replaced nine single-column foreign keys with composite ones
 * that carry the tenant. The old form said the parent EXISTS; the new form
 * says it belongs to the same business.
 *
 * Application code checked this already, and the adversarial audit found no
 * reachable path around it. That is deliberately not what these tests
 * exercise. They go straight at the table on the owner credential — no
 * repository, no command, no policy in the way — because the property the
 * ruling asked for is that the relationship is *unrepresentable*, not that
 * today's callers happen not to represent it.
 *
 * Each case takes a row that is already valid and repoints one column at
 * another tenant's parent. That is the whole attack in one UPDATE, and it
 * needs no fixture gymnastics to set up.
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
  /* The OWNER credential, deliberately. Row-level security would refuse the
   * cross-tenant write on its own, which would make these tests pass without
   * the foreign keys existing at all. The owner is not subject to the
   * policies unless a table forces them, so what refuses here is the
   * constraint and nothing else. */
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
  /**
   * `child.column -> parent`, as the remediation plan lists it.
   *
   * Spelled out rather than composed in the test title: vitest reads
   * `$child.$column` as a nested property path and renders `undefined`.
   */
  readonly edge: string;
  readonly child: string;
  readonly column: string;
  readonly parent: string;
  readonly constraint: string;
}

const GROUP_A: readonly Edge[] = [
  {
    edge: 'credit_notes.invoice_id -> invoices',
    child: 'credit_notes',
    column: 'invoice_id',
    parent: 'invoices',
    constraint: 'credit_notes_invoice_business_fk',
  },
  {
    edge: 'customer_identities.customer_id -> customers',
    child: 'customer_identities',
    column: 'customer_id',
    parent: 'customers',
    constraint: 'customer_identities_customer_business_fk',
  },
  {
    edge: 'invoice_items.invoice_id -> invoices',
    child: 'invoice_items',
    column: 'invoice_id',
    parent: 'invoices',
    constraint: 'invoice_items_invoice_business_fk',
  },
  {
    edge: 'invoices.customer_id -> customers',
    child: 'invoices',
    column: 'customer_id',
    parent: 'customers',
    constraint: 'invoices_customer_business_fk',
  },
  {
    edge: 'invoices.order_id -> orders',
    child: 'invoices',
    column: 'order_id',
    parent: 'orders',
    constraint: 'invoices_order_business_fk',
  },
  {
    edge: 'order_items.order_id -> orders',
    child: 'order_items',
    column: 'order_id',
    parent: 'orders',
    constraint: 'order_items_order_business_fk',
  },
  {
    edge: 'order_items.product_id -> products',
    child: 'order_items',
    column: 'product_id',
    parent: 'products',
    constraint: 'order_items_product_business_fk',
  },
  {
    edge: 'orders.customer_id -> customers',
    child: 'orders',
    column: 'customer_id',
    parent: 'customers',
    constraint: 'orders_customer_business_fk',
  },
  {
    edge: 'orders.invoice_id -> invoices',
    child: 'orders',
    column: 'invoice_id',
    parent: 'invoices',
    constraint: 'orders_invoice_business_fk',
  },
];

describe('group A: a tenant-owned child cannot name another tenant’s parent', () => {
  it.each(GROUP_A)(
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
      /* NOT VALID is how the migration takes a lighter lock; leaving it that
       * way would be a constraint nobody can rely on. */
      expect(row?.validated).toBe(true);
    },
  );

  it.each(GROUP_A)('$edge: the weaker single-column key is gone', async ({ child, column }) => {
    const rows = await owner.execute<{ conname: string }>(sql`
        SELECT con.conname
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = con.conkey[1]
         WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1
           AND c.relname = ${child} AND a.attname = ${column}
      `);

    /* Two keys enforcing overlapping things is how the ledger's duplicate
     * happened. The stronger one replaces the weaker; it does not join it. */
    expect([...rows].map((r) => r.conname)).toEqual([]);
  });
});

/**
 * One business with the full cast, so every edge below has a real child row
 * to repoint. Written on the owner credential in raw SQL rather than through
 * the repositories, because a repository would refuse the cross-tenant write
 * for its own reasons and the point is to get past every such reason and find
 * out what the DATABASE does.
 */
async function seedCast(tag: string): Promise<Record<string, string>> {
  const user = await identity.upsertUserByPhone(owner, `+23480${tag.padStart(8, '0')}`);
  const business = await identity.createBusinessWithOwner(owner, {
    name: `Cast ${tag}`,
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

  const customer = await one(sql`
    INSERT INTO customers (business_id, token) VALUES (${b}::uuid, ${`tok-${tag}`}) RETURNING id`);
  const product = await one(sql`
    INSERT INTO products (business_id, name) VALUES (${b}::uuid, ${`Product ${tag}`}) RETURNING id`);
  const order = await one(sql`
    INSERT INTO orders (business_id, order_number, total_k, source_type, customer_id)
    VALUES (${b}::uuid, ${`ORD-${tag}`}, 1000, 'chat', ${customer}::uuid) RETURNING id`);
  const invoice = await one(sql`
    INSERT INTO invoices (business_id, invoice_number, subtotal_k, total_k, balance_due_k,
                          source_type, customer_id, order_id)
    VALUES (${b}::uuid, ${`INV-${tag}`}, 1000, 1000, 1000, 'chat', ${customer}::uuid, ${order}::uuid)
    RETURNING id`);
  await owner.execute(
    sql`UPDATE orders SET invoice_id = ${invoice}::uuid WHERE id = ${order}::uuid`,
  );
  const invoiceItem = await one(sql`
    INSERT INTO invoice_items (business_id, invoice_id, name, quantity, unit_price_k, line_total_k)
    VALUES (${b}::uuid, ${invoice}::uuid, 'Line', 1, 1000, 1000) RETURNING id`);
  const orderItem = await one(sql`
    INSERT INTO order_items (business_id, order_id, name, quantity, unit_price_k, line_total_k, product_id)
    VALUES (${b}::uuid, ${order}::uuid, 'Line', 1, 1000, 1000, ${product}::uuid) RETURNING id`);
  const creditNote = await one(sql`
    INSERT INTO credit_notes (business_id, invoice_id, credit_note_number, amount_k, reason, actor)
    VALUES (${b}::uuid, ${invoice}::uuid, ${`CN-${tag}`}, 100, 'returned', 'owner') RETURNING id`);
  const customerIdentity = await one(sql`
    INSERT INTO customer_identities (business_id, customer_id, facet, ciphertext)
    VALUES (${b}::uuid, ${customer}::uuid, 'phone', 'sealed') RETURNING id`);

  return {
    business: b,
    customers: customer,
    products: product,
    orders: order,
    invoices: invoice,
    invoice_items: invoiceItem,
    order_items: orderItem,
    credit_notes: creditNote,
    customer_identities: customerIdentity,
  };
}

describe('group A: the refusal is the database’s, not the application’s', () => {
  it.each(GROUP_A)(
    '$edge: cannot be repointed at another tenant’s row',
    async ({ child, column, parent, constraint }) => {
      const mine = await seedCast('1');
      const theirs = await seedCast('2');

      /* Same tenant first. If this failed, the test below would pass for the
       * wrong reason — a constraint that refuses everything proves nothing. */
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
      /* Named, so the failure says WHICH guarantee held rather than merely
       * that something went wrong. */
      expect(String(refusal?.cause)).toContain(constraint);
    },
  );
});
