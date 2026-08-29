/**
 * The §10 invariant table, exercised at the door it guards (PR-039). The
 * application refuses first with a better message (`assertBalanced`); every
 * probe here goes around it on purpose, because the trigger exists for the
 * writer nobody has thought of yet.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, journalRepo, sql, withBusiness, type Db } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 8 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481798${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** The refusal PostgreSQL actually raised, unwrapped from the driver. */
function said(error: unknown): string {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    const c = e as { message?: string; cause?: unknown };
    if (c.message && !c.message.startsWith('Failed query')) return c.message;
    e = c.cause;
  }
  return String(error);
}

/** Raw lines through one raw transaction, committed together or not at all. */
function post(businessId: string, lines: Array<{ code: string; d: number; c: number }>) {
  seq += 1;
  return withBusiness(db, businessId, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      INSERT INTO ledger_transactions (business_id, memo, source_type, source_id)
      VALUES (${businessId}::uuid, 'invariant probe', 'manual', ${`inv-${seq}`})
      RETURNING id
    `);
    const txId = [...rows][0]!.id;
    for (const l of lines) {
      await tx.execute(sql`
        INSERT INTO ledger_entries
          (business_id, transaction_id, account_id, debit_k, credit_k, transaction_amount_minor)
        VALUES (${businessId}::uuid, ${txId}::uuid,
                (SELECT id FROM accounts WHERE business_id = ${businessId}::uuid AND code = ${l.code}),
                ${l.d}, ${l.c}, ${l.d + l.c})
      `);
    }
  });
}

describe('shape at commit (§10 rows 1 and 3)', () => {
  it('an unbalanced entry is refused when it tries to commit', async () => {
    const businessId = await seedBusiness();
    const refusal = await post(businessId, [
      { code: '1000', d: 100, c: 0 },
      { code: '4000', d: 0, c: 90 },
    ]).then(() => 'committed', said);
    expect(refusal).toMatch(/does not balance: 100 debit vs 90 credit/);
  });

  it('a single-line entry is refused', async () => {
    const businessId = await seedBusiness();
    const refusal = await post(businessId, [{ code: '1000', d: 100, c: 0 }]).then(
      () => 'committed',
      said,
    );
    expect(refusal).toMatch(/has 1 line\(s\): at least two/);
  });

  it('an entry with no lines at all is refused', async () => {
    const businessId = await seedBusiness();
    const refusal = await post(businessId, []).then(() => 'committed', said);
    expect(refusal).toMatch(/has 0 line\(s\): at least two/);
  });

  it('a balanced two-line entry commits', async () => {
    const businessId = await seedBusiness();
    await expect(
      post(businessId, [
        { code: '1000', d: 100, c: 0 },
        { code: '4000', d: 0, c: 100 },
      ]),
    ).resolves.toBeUndefined();
  });
});

describe('one side per line (§10 row 2)', () => {
  it('a line with both sides zero is unrepresentable', async () => {
    const businessId = await seedBusiness();
    const refusal = await post(businessId, [
      { code: '1000', d: 0, c: 0 },
      { code: '4000', d: 0, c: 0 },
    ]).then(() => 'committed', said);
    expect(refusal).toMatch(/ledger_entries_one_sided|one_sided/);
  });

  it('a line with both sides set is unrepresentable', async () => {
    const businessId = await seedBusiness();
    const refusal = await post(businessId, [
      { code: '1000', d: 100, c: 100 },
      { code: '4000', d: 100, c: 100 },
    ]).then(() => 'committed', said);
    expect(refusal).toMatch(/one_sided/);
  });
});

describe('tenant and currency (§10 rows 4 and 7)', () => {
  it("an entry citing another tenant's transaction is unrepresentable", async () => {
    const ada = await seedBusiness();
    const bola = await seedBusiness();
    /* Bola posts a legitimate entry; Ada tries to hang a line off it. */
    await post(bola, [
      { code: '1000', d: 100, c: 0 },
      { code: '4000', d: 0, c: 100 },
    ]);
    const bolaTx = await withBusiness(db, bola, (tx) =>
      tx.execute<{ id: string }>(
        sql`SELECT id FROM ledger_transactions WHERE business_id = ${bola}::uuid LIMIT 1`,
      ),
    );
    const foreignTx = [...bolaTx][0]!.id;
    await expect(
      withBusiness(db, ada, (tx) =>
        tx.execute(sql`
          INSERT INTO ledger_entries
            (business_id, transaction_id, account_id, debit_k, credit_k, transaction_amount_minor)
          VALUES (${ada}::uuid, ${foreignTx}::uuid,
                  (SELECT id FROM accounts WHERE business_id = ${ada}::uuid AND code = '1000'),
                  100, 0, 100)
        `),
      ),
    ).rejects.toThrow();
  });

  it('a functional currency that is not the business currency is refused', async () => {
    const businessId = await seedBusiness();
    const refusal = await withBusiness(db, businessId, (tx) =>
      tx.execute(sql`
        INSERT INTO ledger_transactions (business_id, memo, source_type, source_id, functional_currency)
        VALUES (${businessId}::uuid, 'usd probe', 'manual', 'usd-1', 'USD')
      `),
    ).then(() => 'inserted', said);
    expect(refusal).toMatch(/functional currency USD is not the business currency NGN/);
  });
});

describe('amount coherence (§10 row 8)', () => {
  it('a same-currency line whose transaction amount disagrees is refused', async () => {
    const businessId = await seedBusiness();
    const refusal = await withBusiness(db, businessId, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO ledger_transactions (business_id, memo, source_type, source_id)
        VALUES (${businessId}::uuid, 'coherence probe', 'manual', 'coh-1') RETURNING id
      `);
      const txId = [...rows][0]!.id;
      await tx.execute(sql`
        INSERT INTO ledger_entries
          (business_id, transaction_id, account_id, debit_k, credit_k, transaction_amount_minor)
        VALUES (${businessId}::uuid, ${txId}::uuid,
                (SELECT id FROM accounts WHERE business_id = ${businessId}::uuid AND code = '1000'),
                100, 0, 250)
      `);
    }).then(() => 'inserted', said);
    expect(refusal).toMatch(/transaction amount 250 must equal its functional amount 100/);
  });
});

describe('the front door still works', () => {
  it('a real posting path commits under every trigger at once', async () => {
    const businessId = await seedBusiness();
    await expect(
      withBusiness(db, businessId, (tx) =>
        journalRepo.recordJournal(tx, {
          businessId,
          memo: 'till to bank',
          amountK: 250_000,
          intoAccount: 'BANK',
          outOfAccount: 'CASH',
          actor: 'user:test',
        }),
      ),
    ).resolves.toBeTruthy();
  });
});
