/**
 * The tenant-composite foreign keys, group B: payments, intents, allocations,
 * receipts, evidence (ruling 1, twelve of thirty-four; group A is 0132).
 *
 * Same shape as the group A suite and for the same reason, which is worth
 * repeating rather than cross-referencing: these run on the OWNER credential,
 * outside row-level security, because RLS would refuse the cross-tenant write
 * on its own and the tests would then pass with no foreign keys at all.
 *
 * What is different is the stakes. `payment_allocations` is the table that
 * says a payment settled an invoice, and `invoices.balance_due_k` is a
 * projection of exactly those rows. An allocation pointing at another tenant's
 * invoice would take a debt off books it never belonged to.
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
  /** Spelled out: vitest reads `$child.$column` as a nested property path. */
  readonly edge: string;
  readonly child: string;
  readonly column: string;
  readonly parent: string;
  readonly constraint: string;
}

const GROUP_B: readonly Edge[] = [
  {
    edge: 'payment_allocations.invoice_id -> invoices',
    child: 'payment_allocations',
    column: 'invoice_id',
    parent: 'invoices',
    constraint: 'payment_allocations_invoice_business_fk',
  },
  {
    edge: 'payment_allocations.payment_id -> payments',
    child: 'payment_allocations',
    column: 'payment_id',
    parent: 'payments',
    constraint: 'payment_allocations_payment_business_fk',
  },
  {
    edge: 'payment_evidence.customer_id -> customers',
    child: 'payment_evidence',
    column: 'customer_id',
    parent: 'customers',
    constraint: 'payment_evidence_customer_business_fk',
  },
  {
    edge: 'payment_intents.customer_id -> customers',
    child: 'payment_intents',
    column: 'customer_id',
    parent: 'customers',
    constraint: 'payment_intents_customer_business_fk',
  },
  {
    edge: 'payment_intents.invoice_id -> invoices',
    child: 'payment_intents',
    column: 'invoice_id',
    parent: 'invoices',
    constraint: 'payment_intents_invoice_business_fk',
  },
  {
    edge: 'payment_intents.order_id -> orders',
    child: 'payment_intents',
    column: 'order_id',
    parent: 'orders',
    constraint: 'payment_intents_order_business_fk',
  },
  {
    edge: 'payment_verifications.payment_id -> payments',
    child: 'payment_verifications',
    column: 'payment_id',
    parent: 'payments',
    constraint: 'payment_verifications_payment_business_fk',
  },
  {
    edge: 'payments.customer_id -> customers',
    child: 'payments',
    column: 'customer_id',
    parent: 'customers',
    constraint: 'payments_customer_business_fk',
  },
  {
    edge: 'payments.payment_intent_id -> payment_intents',
    child: 'payments',
    column: 'payment_intent_id',
    parent: 'payment_intents',
    constraint: 'payments_payment_intent_business_fk',
  },
  {
    edge: 'receipts.customer_id -> customers',
    child: 'receipts',
    column: 'customer_id',
    parent: 'customers',
    constraint: 'receipts_customer_business_fk',
  },
  {
    edge: 'receipts.invoice_id -> invoices',
    child: 'receipts',
    column: 'invoice_id',
    parent: 'invoices',
    constraint: 'receipts_invoice_business_fk',
  },
  {
    edge: 'receipts.payment_id -> payments',
    child: 'receipts',
    column: 'payment_id',
    parent: 'payments',
    constraint: 'receipts_payment_business_fk',
  },
];

describe('group B: the keys are declared as the ruling asked', () => {
  it.each(GROUP_B)(
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

  it.each(GROUP_B)('$edge: the weaker single-column key is gone', async ({ child, column }) => {
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
});

/** One business with the payments cast, written raw so no repository is in the way. */
async function seedCast(tag: string): Promise<Record<string, string>> {
  const user = await identity.upsertUserByPhone(owner, `+23481${tag.padStart(8, '0')}`);
  const business = await identity.createBusinessWithOwner(owner, {
    name: `Payments ${tag}`,
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
    INSERT INTO customers (business_id, token) VALUES (${b}::uuid, ${`tok-b-${tag}`}) RETURNING id`);
  const order = await one(sql`
    INSERT INTO orders (business_id, order_number, total_k, source_type, customer_id)
    VALUES (${b}::uuid, ${`ORD-B-${tag}`}, 1000, 'chat', ${customer}::uuid) RETURNING id`);
  const invoice = await one(sql`
    INSERT INTO invoices (business_id, invoice_number, subtotal_k, total_k, balance_due_k,
                          source_type, customer_id, order_id)
    VALUES (${b}::uuid, ${`INV-B-${tag}`}, 1000, 1000, 1000, 'chat', ${customer}::uuid, ${order}::uuid)
    RETURNING id`);
  const intent = await one(sql`
    INSERT INTO payment_intents (business_id, provider_type, reference, expected_amount_k,
                                 customer_id, invoice_id, order_id)
    VALUES (${b}::uuid, 'paystack', ${`REF-${tag}`}, 1000, ${customer}::uuid, ${invoice}::uuid,
            ${order}::uuid) RETURNING id`);
  const evidence = await one(sql`
    INSERT INTO payment_evidence (business_id, source, customer_id)
    VALUES (${b}::uuid, 'chat', ${customer}::uuid) RETURNING id`);
  const payment = await one(sql`
    INSERT INTO payments (business_id, amount_k, source_type, customer_id, payment_intent_id)
    VALUES (${b}::uuid, 1000, 'chat', ${customer}::uuid, ${intent}::uuid) RETURNING id`);
  const allocation = await one(sql`
    INSERT INTO payment_allocations (business_id, payment_id, invoice_id, amount_k)
    VALUES (${b}::uuid, ${payment}::uuid, ${invoice}::uuid, 1000) RETURNING id`);
  const receipt = await one(sql`
    INSERT INTO receipts (business_id, receipt_number, payment_id, amount_k, customer_id, invoice_id)
    VALUES (${b}::uuid, ${`RCP-${tag}`}, ${payment}::uuid, 1000, ${customer}::uuid, ${invoice}::uuid)
    RETURNING id`);
  const verification = await one(sql`
    INSERT INTO payment_verifications (business_id, payment_id, source)
    VALUES (${b}::uuid, ${payment}::uuid, 'PROVIDER_VERIFIED') RETURNING id`);

  return {
    customers: customer,
    orders: order,
    invoices: invoice,
    payment_intents: intent,
    payment_evidence: evidence,
    payments: payment,
    payment_allocations: allocation,
    receipts: receipt,
    payment_verifications: verification,
  };
}

describe('group B: the refusal is the database’s, not the application’s', () => {
  it.each(GROUP_B)(
    '$edge: cannot be repointed at another tenant’s row',
    async ({ child, column, parent, constraint }) => {
      const mine = await seedCast('1');
      const theirs = await seedCast('2');

      /* Same tenant first: a constraint that refused everything would pass the
       * cross-tenant case below and prove nothing. */
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
});
