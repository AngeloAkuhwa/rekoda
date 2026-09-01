/**
 * The tenant-composite foreign keys, group D: reconciliation and ledger
 * provenance (ruling 1, six of thirty-four; A is 0132, B 0133, C 0134).
 *
 * The group the remediation plan flagged for highest care. Five of these six
 * attach a business record to a POSTED LEDGER TRANSACTION, so a cross-tenant
 * link here is not an untidy join: it is a business record claiming provenance
 * in another tenant's financial history.
 *
 * Ledger transactions are append-only (0051) and posted drafts are locked
 * (0073), so nothing here could rewrite history. The narrower guarantee is
 * what was missing, and it is what these tests pin: the row POINTING at that
 * history belongs to the same tenant as the history it points at.
 *
 * On the OWNER credential and outside row-level security, for the reason the
 * earlier groups give: RLS would refuse the cross-tenant write anyway, so
 * these tests would pass with no foreign keys at all.
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

const GROUP_D: readonly Edge[] = [
  {
    edge: 'bank_line_matches.transaction_id -> ledger_transactions',
    child: 'bank_line_matches',
    column: 'transaction_id',
    parent: 'ledger_transactions',
    constraint: 'bank_line_matches_tx_business_fk',
  },
  {
    edge: 'credit_notes.ledger_transaction_id -> ledger_transactions',
    child: 'credit_notes',
    column: 'ledger_transaction_id',
    parent: 'ledger_transactions',
    constraint: 'credit_notes_tx_business_fk',
  },
  {
    edge: 'expenses.ledger_transaction_id -> ledger_transactions',
    child: 'expenses',
    column: 'ledger_transaction_id',
    parent: 'ledger_transactions',
    constraint: 'expenses_tx_business_fk',
  },
  {
    edge: 'fixed_assets.ledger_transaction_id -> ledger_transactions',
    child: 'fixed_assets',
    column: 'ledger_transaction_id',
    parent: 'ledger_transactions',
    constraint: 'fixed_assets_tx_business_fk',
  },
  {
    edge: 'reconciliations.payment_id -> payments',
    child: 'reconciliations',
    column: 'payment_id',
    parent: 'payments',
    constraint: 'reconciliations_payment_business_fk',
  },
  {
    edge: 'supplier_payments.ledger_transaction_id -> ledger_transactions',
    child: 'supplier_payments',
    column: 'ledger_transaction_id',
    parent: 'ledger_transactions',
    constraint: 'supplier_payments_tx_business_fk',
  },
];

describe('group D: the keys are declared as the ruling asked', () => {
  it.each(GROUP_D)(
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

  it.each(GROUP_D)('$edge: the weaker single-column key is gone', async ({ child, column }) => {
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

  it('leaves the ledger_entries duplicate alone, which is a separate ruling', async () => {
    const rows = await owner.execute<{ conname: string }>(sql`
      SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = con.conkey[1]
       WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1
         AND c.relname = 'ledger_entries' AND a.attname = 'transaction_id'
    `);

    /* `ledger_entries.transaction_id` carries BOTH the composite key (0070)
     * and a redundant single-column one. It sits right beside these six and
     * would have been easy to sweep up, but ruling 5 put it in its own
     * cleanup. Asserted so that leaving it is a recorded decision rather than
     * something nobody noticed. */
    expect([...rows].map((r) => r.conname)).toHaveLength(1);
  });
});

/** One business with the provenance cast, written raw so no repository is in the way. */
async function seedCast(tag: string): Promise<Record<string, string>> {
  const user = await identity.upsertUserByPhone(owner, `+23483${tag.padStart(8, '0')}`);
  const business = await identity.createBusinessWithOwner(owner, {
    name: `Provenance ${tag}`,
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

  /* A real posting: migration 0070 refuses a transaction with fewer than two
   * lines, so it and its balanced entries are written together. */
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
    INSERT INTO customers (business_id, token) VALUES (${b}::uuid, ${`tok-d-${tag}`}) RETURNING id`);
  const invoice = await one(sql`
    INSERT INTO invoices (business_id, invoice_number, subtotal_k, total_k, balance_due_k,
                          source_type, customer_id)
    VALUES (${b}::uuid, ${`INV-D-${tag}`}, 1000, 1000, 1000, 'chat', ${customer}::uuid) RETURNING id`);
  const payment = await one(sql`
    INSERT INTO payments (business_id, amount_k, source_type, customer_id)
    VALUES (${b}::uuid, 1000, 'chat', ${customer}::uuid) RETURNING id`);
  const line = await one(sql`
    INSERT INTO bank_statement_lines (business_id, posted_on, amount_k, fingerprint)
    VALUES (${b}::uuid, CURRENT_DATE, 1000, ${`fp-${tag}`}) RETURNING id`);
  const match = await one(sql`
    INSERT INTO bank_line_matches (business_id, line_id, transaction_id, decided_by, tier)
    VALUES (${b}::uuid, ${line}::uuid, ${transaction}::uuid, 'auto', 1) RETURNING id`);
  const creditNote = await one(sql`
    INSERT INTO credit_notes (business_id, invoice_id, credit_note_number, amount_k, reason,
                              actor, ledger_transaction_id)
    VALUES (${b}::uuid, ${invoice}::uuid, ${`CN-D-${tag}`}, 100, 'returned', 'owner',
            ${transaction}::uuid) RETURNING id`);
  const expense = await one(sql`
    INSERT INTO expenses (business_id, description, amount_k, source_type, ledger_transaction_id)
    VALUES (${b}::uuid, 'Fixture spend', 1000, 'chat', ${transaction}::uuid) RETURNING id`);
  const asset = await one(sql`
    INSERT INTO fixed_assets (business_id, description, cost_k, useful_life_months, bought_on,
                              ledger_transaction_id)
    VALUES (${b}::uuid, 'Fixture asset', 1000, 12, CURRENT_DATE, ${transaction}::uuid) RETURNING id`);
  const reconciliation = await one(sql`
    INSERT INTO reconciliations (business_id, status, payment_id)
    VALUES (${b}::uuid, 'MATCHED', ${payment}::uuid) RETURNING id`);
  const supplierPayment = await one(sql`
    INSERT INTO supplier_payments (business_id, expense_id, amount_k, method,
                                   ledger_transaction_id, paid_on)
    VALUES (${b}::uuid, ${expense}::uuid, 1000, 'cash', ${transaction}::uuid, CURRENT_DATE)
    RETURNING id`);

  return {
    ledger_transactions: transaction,
    customers: customer,
    invoices: invoice,
    payments: payment,
    bank_statement_lines: line,
    bank_line_matches: match,
    credit_notes: creditNote,
    expenses: expense,
    fixed_assets: asset,
    reconciliations: reconciliation,
    supplier_payments: supplierPayment,
  };
}

describe('group D: a business record cannot claim another tenant’s financial history', () => {
  it.each(GROUP_D)(
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
