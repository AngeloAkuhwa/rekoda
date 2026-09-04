/**
 * Ruling 5: the two redundant single-column foreign keys are gone, and the
 * tenant-composite keys hold alone (migration 0147).
 *
 * Each of these columns carried TWO foreign keys to the same parent — the
 * original single-column key and the composite that superseded it. The
 * composite subsumes the weak key in every reachable case (both columns
 * NOT NULL on ledger_entries; on payment_intents a NULL connection exempts
 * both keys alike), and none of the four constraints carried ON DELETE or
 * ON UPDATE behaviour, so nothing but noise was removed. These tests are the
 * receipt: the weak keys are gone, the strong ones are validated, and the
 * cross-tenant write each strong key exists to stop is still stopped.
 *
 * Run on the OWNER credential and outside row-level security, for the reason
 * every group in this family gives: RLS would refuse the cross-tenant write
 * on its own, and these tests exist to prove the CONSTRAINT does.
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

const RULING_5 = [
  {
    edge: 'ledger_entries.transaction_id -> ledger_transactions',
    child: 'ledger_entries',
    dropped: 'ledger_entries_transaction_id_ledger_transactions_id_fk',
    kept: 'ledger_entries_tx_business_fk',
    keptDef:
      'FOREIGN KEY (business_id, transaction_id) REFERENCES ledger_transactions(business_id, id)',
  },
  {
    edge: 'payment_intents.payment_connection_id -> payment_connections',
    child: 'payment_intents',
    dropped: 'payment_intents_payment_connection_id_fkey',
    kept: 'payment_intents_connection_fk',
    keptDef:
      'FOREIGN KEY (business_id, payment_connection_id) REFERENCES payment_connections(business_id, id)',
  },
] as const;

describe('ruling 5: one key per edge, and it is the tenant-composite one', () => {
  it.each(RULING_5)('$edge: the single-column key is gone', async ({ child, dropped }) => {
    const rows = await owner.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
       WHERE c.relname = ${child} AND con.conname = ${dropped}
    `);
    expect([...rows][0]?.n).toBe(0);
  });

  it.each(RULING_5)(
    '$edge: the composite key remains, validated, plain REFERENCES',
    async ({ child, kept, keptDef }) => {
      const rows = await owner.execute<{ def: string; validated: boolean }>(sql`
        SELECT pg_get_constraintdef(con.oid) AS def, con.convalidated AS validated
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
         WHERE c.relname = ${child} AND con.conname = ${kept}
      `);
      const row = [...rows][0];
      /* The exact definition, so an ON DELETE quietly gained or lost in some
       * later swap fails here by name. Neither weak key carried one, so the
       * drop changed no delete-time behaviour — which this asserts. */
      expect(row?.def).toBe(keptDef);
      expect(row?.validated).toBe(true);
    },
  );

  it('closes ruling 5: no column anywhere carries both a composite and a single-column key', async () => {
    /* The measurement, kept as a test the way group F keeps its closure: the
     * next duplicate does not wait for the next audit. */
    const rows = await owner.execute<{ dup: string }>(sql`
      SELECT c.relname || '.' || a.attname AS dup
        FROM pg_constraint k
        JOIN pg_class c ON c.oid = k.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.conkey[1]
       WHERE k.contype = 'f' AND array_length(k.conkey, 1) = 1
         AND EXISTS (SELECT 1 FROM pg_constraint k2
                      WHERE k2.conrelid = c.oid AND k2.contype = 'f'
                        AND array_length(k2.conkey, 1) = 2
                        AND pg_get_constraintdef(k2.oid) LIKE '%, ' || a.attname || ') REFERENCES%')
       ORDER BY 1
    `);
    expect([...rows].map((r) => r.dup)).toEqual([]);
  });
});

interface Cast {
  business: string;
  connection: string;
  account: string;
  transaction: string;
}

async function seedCast(tag: string): Promise<Cast> {
  const user = await identity.upsertUserByPhone(owner, `+23486${tag.padStart(8, '0')}`);
  const business = await identity.createBusinessWithOwner(owner, {
    name: `Ledger ${tag}`,
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
    VALUES (${b}::uuid, 'paystack', 'active') RETURNING id`);
  /* `createBusinessWithOwner` seeds the chart of accounts (PR-030), so
   * accounts are picked, not invented. The journal is written LEGALLY — a
   * transaction and two balanced lines in one database transaction — because
   * 0070's commit-time invariants refuse anything less, and a fixture that
   * had to silence them would prove nothing later. Committing this journal is
   * also the same-tenant control for the entries edge. */
  const accounts = await owner.execute<{ id: string }>(sql`
    SELECT id FROM accounts WHERE business_id = ${b}::uuid ORDER BY code LIMIT 2`);
  const [debit, credit] = [...accounts].map((r) => r.id);
  if (!debit || !credit) throw new Error('fixture found no seeded accounts');

  const transaction = await owner.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      INSERT INTO ledger_transactions (business_id, memo, source_type)
      VALUES (${b}::uuid, 'ruling 5 fixture', 'manual') RETURNING id`);
    const id = [...rows][0]?.id;
    if (!id) throw new Error('fixture insert returned no id');
    await tx.execute(sql`
      INSERT INTO ledger_entries (business_id, transaction_id, account_id, debit_k, credit_k,
                                  transaction_currency, transaction_amount_minor)
      VALUES (${b}::uuid, ${id}::uuid, ${debit}::uuid, 1000, 0, 'NGN', 1000),
             (${b}::uuid, ${id}::uuid, ${credit}::uuid, 0, 1000, 'NGN', 1000)`);
    return id;
  });

  return { business: b, connection, account: debit, transaction };
}

const refusalOf = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: Error & { cause?: unknown }) => error,
  );

describe('ruling 5: the composite alone still refuses the cross-tenant write', () => {
  it('an intent cannot cite another tenant’s connection', async () => {
    const mine = await seedCast('1');
    const theirs = await seedCast('2');

    /* Same tenant first: a constraint refusing everything would pass the
     * cross-tenant case and prove nothing. */
    await expect(
      owner.execute(sql`
        INSERT INTO payment_intents (business_id, provider_type, payment_connection_id, reference, expected_amount_k)
        VALUES (${mine.business}::uuid, 'paystack', ${mine.connection}::uuid, 'RKD-PAY-R5-SAME', 1000)`),
    ).resolves.toBeDefined();

    const refusal = await refusalOf(
      owner.execute(sql`
        INSERT INTO payment_intents (business_id, provider_type, payment_connection_id, reference, expected_amount_k)
        VALUES (${mine.business}::uuid, 'paystack', ${theirs.connection}::uuid, 'RKD-PAY-R5-CROSS', 1000)`),
    );
    expect(refusal, "an intent accepted another tenant's connection").not.toBeNull();
    expect(String(refusal?.cause)).toContain('payment_intents_connection_fk');
  });

  it('an entry cannot post into another tenant’s transaction, even with every trigger silenced', async () => {
    const mine = await seedCast('3');
    const theirs = await seedCast('4');

    /* The same-tenant control already ran: seedCast committed a balanced
     * two-line journal into ${mine.transaction} through the same key. */

    /* The straight cross-tenant insert IS refused today, but by the currency
     * trigger, not the key: its tenant-scoped lookup finds no transaction and
     * reports a cross-currency line. A refusal with the wrong name is the
     * masking trap wearing a trigger, so the proof disables USER triggers —
     * foreign keys are internal triggers and stay live — and demands the
     * refusal carry the constraint's own name. All inside one rolled-back
     * transaction; the catalogue is untouched afterwards. */
    const refusal = await refusalOf(
      owner.transaction(async (tx) => {
        await tx.execute(sql`ALTER TABLE ledger_entries DISABLE TRIGGER USER`);
        await tx.execute(sql`
          INSERT INTO ledger_entries (business_id, transaction_id, account_id, debit_k, credit_k,
                                      transaction_currency, transaction_amount_minor)
          VALUES (${mine.business}::uuid, ${theirs.transaction}::uuid, ${mine.account}::uuid,
                  1000, 0, 'NGN', 1000)`);
      }),
    );
    expect(refusal, "an entry accepted another tenant's transaction").not.toBeNull();
    expect(String(refusal?.cause)).toContain('ledger_entries_tx_business_fk');

    const triggers = await owner.execute<{ disabled: number }>(sql`
      SELECT count(*)::int AS disabled FROM pg_trigger
       WHERE tgrelid = 'ledger_entries'::regclass AND tgenabled = 'D'`);
    expect([...triggers][0]?.disabled, 'the rollback restored every trigger').toBe(0);
  });
});
