/**
 * Six columns that had NO foreign key at all, now constrained (migration 0137).
 *
 * These are a different finding from ruling 1's thirty-four. Those were WEAK
 * keys — the parent had to exist, but nothing said whose it was. These said
 * nothing whatever: `invoices.ledger_transaction_id` could name a posting that
 * never existed, or one belonging to another merchant, and the database had no
 * opinion. Its own comment promised "a null means unattributed rather than
 * something invented"; only now is that a promise the schema keeps.
 *
 * On the OWNER credential and outside row-level security, for the reason the
 * group suites give: RLS would refuse the cross-tenant write anyway, so these
 * would pass with no foreign keys at all.
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

const EDGES: readonly Edge[] = [
  {
    edge: 'invoices.ledger_transaction_id -> ledger_transactions',
    child: 'invoices',
    column: 'ledger_transaction_id',
    parent: 'ledger_transactions',
    constraint: 'invoices_tx_business_fk',
  },
  {
    edge: 'bills.ledger_transaction_id -> ledger_transactions',
    child: 'bills',
    column: 'ledger_transaction_id',
    parent: 'ledger_transactions',
    constraint: 'bills_tx_business_fk',
  },
  {
    edge: 'goods_returns.ledger_transaction_id -> ledger_transactions',
    child: 'goods_returns',
    column: 'ledger_transaction_id',
    parent: 'ledger_transactions',
    constraint: 'goods_returns_tx_business_fk',
  },
  {
    edge: 'tax_events.journal_id -> ledger_transactions',
    child: 'tax_events',
    column: 'journal_id',
    parent: 'ledger_transactions',
    constraint: 'tax_events_journal_business_fk',
  },
  {
    edge: 'ledger_transactions.reverses_id -> ledger_transactions',
    child: 'ledger_transactions',
    column: 'reverses_id',
    parent: 'ledger_transactions',
    constraint: 'ledger_transactions_reverses_business_fk',
  },
  {
    edge: 'revenue_recognition_events.order_line_id -> order_items',
    child: 'revenue_recognition_events',
    column: 'order_line_id',
    parent: 'order_items',
    constraint: 'rre_order_line_business_fk',
  },
];

describe('columns that had no foreign key now have a tenant-composite one', () => {
  it.each(EDGES)(
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

  it('gives order_items the unique key those references point at', async () => {
    const rows = await owner.execute<{ def: string }>(sql`
      SELECT pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
       WHERE c.relname = 'order_items' AND con.conname = 'order_items_business_id_ux'
    `);

    /* A composite foreign key needs a matching unique on the parent. Every
     * other parent in this schema already exposed one; order_items did not,
     * which is why the recognition edge could not have been added before. */
    expect([...rows][0]?.def).toBe('UNIQUE (business_id, id)');
  });

  it('leaves the two financial_transaction_id columns alone, deliberately', async () => {
    const rows = await owner.execute<{ relname: string }>(sql`
      SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'financial_transaction_id'
       WHERE c.relkind = 'r'
         AND NOT EXISTS (SELECT 1 FROM pg_constraint k
                          WHERE k.conrelid = c.oid AND k.contype = 'f'
                            AND a.attnum = ANY (k.conkey))
       ORDER BY c.relname
    `);

    /* No `financial_transactions` table exists, nothing assigns either column,
     * and 0057 describes the intent only as "the bank line". A key here would
     * be a guess at which table that means, and a wrong guess is worse than
     * the absence because it would look like enforcement. Asserted so the
     * omission is a recorded decision, and so this fails if a writer ever
     * appears and someone constrains them without revisiting the reasoning. */
    expect([...rows].map((r) => r.relname)).toEqual([
      'payment_verification_claims',
      'payment_verifications',
    ]);
  });
});

/** Two businesses, each with a posting and an order line to point at. */
async function seedCast(tag: string): Promise<Record<string, string>> {
  const user = await identity.upsertUserByPhone(owner, `+23484${tag.padStart(8, '0')}`);
  const business = await identity.createBusinessWithOwner(owner, {
    name: `Unconstrained ${tag}`,
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

  const customer = await one(sql`
    INSERT INTO customers (business_id, token) VALUES (${b}::uuid, ${`tok-u-${tag}`}) RETURNING id`);
  const order = await one(sql`
    INSERT INTO orders (business_id, order_number, total_k, source_type, customer_id)
    VALUES (${b}::uuid, ${`UO-${tag}`}, 1000, 'chat', ${customer}::uuid) RETURNING id`);
  const orderItem = await one(sql`
    INSERT INTO order_items (business_id, order_id, name, quantity, unit_price_k, line_total_k)
    VALUES (${b}::uuid, ${order}::uuid, 'line', 1, 1000, 1000) RETURNING id`);
  const invoice = await one(sql`
    INSERT INTO invoices (business_id, invoice_number, subtotal_k, total_k, balance_due_k,
                          source_type, customer_id, ledger_transaction_id)
    VALUES (${b}::uuid, ${`UI-${tag}`}, 1000, 1000, 1000, 'chat', ${customer}::uuid,
            ${transaction}::uuid) RETURNING id`);

  return {
    businesses: b,
    ledger_transactions: transaction,
    order_items: orderItem,
    invoices: invoice,
    customers: customer,
    orders: order,
  };
}

describe('a posting cannot be claimed by another tenant’s record', () => {
  it('invoices.ledger_transaction_id refuses another tenant’s posting', async () => {
    const mine = await seedCast('1');
    const theirs = await seedCast('2');

    /* Same tenant first: a constraint that refused everything would pass the
     * cross-tenant case and prove nothing. */
    await expect(
      owner.execute(
        sql.raw(`UPDATE invoices SET ledger_transaction_id = '${mine['ledger_transactions']}'
                  WHERE id = '${mine['invoices']}'`),
      ),
    ).resolves.toBeDefined();

    const refusal = await owner
      .execute(
        sql.raw(`UPDATE invoices SET ledger_transaction_id = '${theirs['ledger_transactions']}'
                  WHERE id = '${mine['invoices']}'`),
      )
      .then(
        () => null,
        (error: Error & { cause?: unknown }) => error,
      );

    expect(refusal).not.toBeNull();
    expect(String(refusal?.cause)).toContain('invoices_tx_business_fk');
  });

  it('invoices.ledger_transaction_id refuses a posting that never existed', async () => {
    const mine = await seedCast('3');

    /* The promise the column's own comment made: "a null means unattributed
     * rather than something invented". Before 0137 this UPDATE succeeded. */
    const refusal = await owner
      .execute(
        sql.raw(`UPDATE invoices
                    SET ledger_transaction_id = '00000000-0000-4000-8000-000000000000'
                  WHERE id = '${mine['invoices']}'`),
      )
      .then(
        () => null,
        (error: Error & { cause?: unknown }) => error,
      );

    expect(refusal).not.toBeNull();
    expect(String(refusal?.cause)).toContain('invoices_tx_business_fk');
  });

  it('revenue_recognition_events.order_line_id refuses another tenant’s line', async () => {
    const mine = await seedCast('6');
    const theirs = await seedCast('7');

    const recognise = (orderLineId: string, sourceId: string) =>
      owner.execute(
        sql.raw(`INSERT INTO revenue_recognition_events
                   (business_id, order_id, order_line_id, source_type, source_id,
                    amount_minor, ledger_transaction_id)
                 VALUES ('${mine['businesses']}', '${mine['orders']}', '${orderLineId}',
                         'fulfilment', '${sourceId}', 1000,
                         '${mine['ledger_transactions']}')`),
      );

    /* The edge that needed a new unique key on order_items. Same tenant first,
     * so the refusal below is about the tenant and not about the shape. */
    await expect(recognise(mine['order_items'] as string, 'own-line')).resolves.toBeDefined();

    const refusal = await recognise(theirs['order_items'] as string, 'their-line').then(
      () => null,
      (error: Error & { cause?: unknown }) => error,
    );

    expect(refusal).not.toBeNull();
    expect(String(refusal?.cause)).toContain('rre_order_line_business_fk');
  });

  it('a reversal chain cannot cross tenants', async () => {
    const mine = await seedCast('4');
    const theirs = await seedCast('5');

    const refusal = await owner
      .execute(
        sql.raw(`UPDATE ledger_transactions SET reverses_id = '${theirs['ledger_transactions']}'
                  WHERE id = '${mine['ledger_transactions']}'`),
      )
      .then(
        () => null,
        (error: Error & { cause?: unknown }) => error,
      );

    expect(refusal).not.toBeNull();
    expect(String(refusal?.cause)).toContain('ledger_transactions_reverses_business_fk');
  });
});
