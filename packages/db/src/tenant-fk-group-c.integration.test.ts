/**
 * The tenant-composite foreign keys, group C: spend, inventory, returns
 * (ruling 1, four of thirty-four; A is 0132, B is 0133).
 *
 * The small group, and the one that contains its own worked example.
 * `goods_returns` has carried the composite key for `product_id` since the
 * table was created and the single-column key for `invoice_id` beside it —
 * one table, both forms, which is what made the finding obvious once anyone
 * looked. This suite asserts they now match.
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
  /** Spelled out: vitest reads `$child.$column` as a nested property path. */
  readonly edge: string;
  readonly child: string;
  readonly column: string;
  readonly parent: string;
  readonly constraint: string;
}

const GROUP_C: readonly Edge[] = [
  {
    edge: 'expenses.supplier_id -> suppliers',
    child: 'expenses',
    column: 'supplier_id',
    parent: 'suppliers',
    constraint: 'expenses_supplier_business_fk',
  },
  {
    edge: 'goods_returns.invoice_id -> invoices',
    child: 'goods_returns',
    column: 'invoice_id',
    parent: 'invoices',
    constraint: 'goods_returns_invoice_business_fk',
  },
  {
    edge: 'inventory_movements.product_id -> products',
    child: 'inventory_movements',
    column: 'product_id',
    parent: 'products',
    constraint: 'inventory_movements_product_business_fk',
  },
  {
    edge: 'supplier_payments.expense_id -> expenses',
    child: 'supplier_payments',
    column: 'expense_id',
    parent: 'expenses',
    constraint: 'supplier_payments_expense_business_fk',
  },
];

describe('group C: the keys are declared as the ruling asked', () => {
  it.each(GROUP_C)(
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

  it.each(GROUP_C)('$edge: the weaker single-column key is gone', async ({ child, column }) => {
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

  it('leaves goods_returns with both of its edges in the same shape', async () => {
    const rows = await owner.execute<{ conname: string; def: string }>(sql`
      SELECT con.conname, pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
       WHERE c.relname = 'goods_returns' AND con.contype = 'f'
         AND con.confrelid <> 'businesses'::regclass
       ORDER BY con.conname
    `);

    /* The whole finding in one table. `product_id` was composite from the
     * start; `invoice_id` was not, for no reason anyone could name. */
    expect([...rows].map((r) => r.def)).toEqual([
      'FOREIGN KEY (business_id, invoice_id) REFERENCES invoices(business_id, id)',
      'FOREIGN KEY (business_id, product_id) REFERENCES products(business_id, id)',
    ]);
  });
});

/** One business with the spend cast, written raw so no repository is in the way. */
async function seedCast(tag: string): Promise<Record<string, string>> {
  const user = await identity.upsertUserByPhone(owner, `+23482${tag.padStart(8, '0')}`);
  const business = await identity.createBusinessWithOwner(owner, {
    name: `Spend ${tag}`,
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
    INSERT INTO customers (business_id, token) VALUES (${b}::uuid, ${`tok-c-${tag}`}) RETURNING id`);
  const invoice = await one(sql`
    INSERT INTO invoices (business_id, invoice_number, subtotal_k, total_k, balance_due_k,
                          source_type, customer_id)
    VALUES (${b}::uuid, ${`INV-C-${tag}`}, 1000, 1000, 1000, 'chat', ${customer}::uuid) RETURNING id`);
  const product = await one(sql`
    INSERT INTO products (business_id, name) VALUES (${b}::uuid, ${`Product C ${tag}`}) RETURNING id`);
  const supplier = await one(sql`
    INSERT INTO suppliers (business_id, name_cipher, match_key)
    VALUES (${b}::uuid, 'sealed', ${`mk-${tag}`}) RETURNING id`);
  /* A posting, not a bare row. Migration 0070's journal invariant refuses a
   * transaction with fewer than two lines, so the transaction and its two
   * balanced entries are written together and the trigger sees them all. */
  const transaction = await owner.transaction(async (tx) => {
    const accounts = await tx.execute<{ id: string }>(sql`
      SELECT id FROM accounts WHERE business_id = ${b}::uuid ORDER BY id LIMIT 2`);
    const [debit, credit] = [...accounts];
    if (!debit || !credit) throw new Error('fixture: business has no seeded accounts');

    const rows = await tx.execute<{ id: string }>(sql`
      INSERT INTO ledger_transactions (business_id, memo, source_type)
      VALUES (${b}::uuid, 'fixture', 'chat') RETURNING id`);
    const id = [...rows][0]?.id;
    if (!id) throw new Error('fixture insert returned no id');

    await tx.execute(sql`
      INSERT INTO ledger_entries (business_id, transaction_id, account_id, debit_k, credit_k,
                                  transaction_amount_minor)
      VALUES (${b}::uuid, ${id}::uuid, ${debit.id}::uuid, 1000, 0, 1000),
             (${b}::uuid, ${id}::uuid, ${credit.id}::uuid, 0, 1000, 1000)`);
    return id;
  });
  const expense = await one(sql`
    INSERT INTO expenses (business_id, description, amount_k, source_type, supplier_id,
                          ledger_transaction_id)
    VALUES (${b}::uuid, 'Fixture spend', 1000, 'chat', ${supplier}::uuid, ${transaction}::uuid)
    RETURNING id`);
  const movement = await one(sql`
    INSERT INTO inventory_movements (business_id, product_id, delta, reason, source_type)
    VALUES (${b}::uuid, ${product}::uuid, 1, 'purchase', 'chat') RETURNING id`);
  const goodsReturn = await one(sql`
    INSERT INTO goods_returns (business_id, product_id, quantity, disposition, source_type, invoice_id)
    VALUES (${b}::uuid, ${product}::uuid, 1, 'RESALABLE', 'chat', ${invoice}::uuid) RETURNING id`);
  const supplierPayment = await one(sql`
    INSERT INTO supplier_payments (business_id, expense_id, amount_k, method,
                                   ledger_transaction_id, paid_on)
    VALUES (${b}::uuid, ${expense}::uuid, 1000, 'cash', ${transaction}::uuid, CURRENT_DATE)
    RETURNING id`);

  return {
    customers: customer,
    invoices: invoice,
    products: product,
    suppliers: supplier,
    ledger_transactions: transaction,
    expenses: expense,
    inventory_movements: movement,
    goods_returns: goodsReturn,
    supplier_payments: supplierPayment,
  };
}

describe('group C: the refusal is the database’s, not the application’s', () => {
  it.each(GROUP_C)(
    '$edge: cannot be repointed at another tenant’s row',
    async ({ child, column, parent, constraint }) => {
      const mine = await seedCast('1');
      const theirs = await seedCast('2');

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
