/**
 * The account lifecycle (spec §11.4; PR-035), proved at both doors: the
 * repo's outcomes, and — for every writer the repo never meets — migration
 * 0066's enforcement. Deactivation exists so history can keep an account
 * the working chart lets go of; a mandatory role never loses its active
 * account; nothing posts into a deactivated one; only the never-posted may
 * be deleted at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  accountsRepo,
  createDb,
  identity,
  issueRepo,
  journalRepo,
  sql,
  withBusiness,
  type Db,
} from './index.js';
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
  const user = await identity.upsertUserByPhone(db, `+23481780${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

async function byRole(businessId: string, role: string) {
  return withBusiness(db, businessId, (tx) =>
    accountsRepo.accountByRole(tx, businessId, role as never),
  );
}

async function byCode(businessId: string, code: string) {
  const all = await withBusiness(db, businessId, (tx) => accountsRepo.accountsFor(tx, businessId));
  return all.find((a) => a.code === code) ?? null;
}

describe('deactivation (§11.4)', () => {
  it('takes an account out of the working chart, and posting into it is refused', async () => {
    const businessId = await seedBusiness();
    const revenue = await byRole(businessId, 'SALES_REVENUE');

    const out = await withBusiness(db, businessId, (tx) =>
      accountsRepo.deactivateAccount(tx, businessId, revenue!.id),
    );
    expect(out).toEqual({ outcome: 'deactivated', replacementId: null });
    expect((await byCode(businessId, '4000'))!.active).toBe(false);

    /* Every sale posts SALES_REVENUE; the deactivated row is a dead end
     * and the refusal says so by name. */
    await expect(
      withBusiness(db, businessId, (tx) =>
        issueRepo.issueSale(tx, {
          businessId,
          customerId: null,
          customerToken: null,
          items: [{ name: 'wig', quantity: 1, unitPriceK: 100_000 }],
          subtotalK: 100_000,
          discountK: 0,
          deliveryFeeK: 0,
          vatK: 0,
          totalK: 100_000,
          paidK: 100_000,
          balanceDueK: 0,
          method: 'cash',
          sourceType: 'chat',
          sourceId: 'draft-x',
          saleSource: null,
          dueDate: null,
          actor: 'system',
        }),
      ),
    ).rejects.toThrow(/deactivated/);
  });

  it('a second deactivation reports itself instead of pretending', async () => {
    const businessId = await seedBusiness();
    const revenue = await byRole(businessId, 'SALES_REVENUE');
    await withBusiness(db, businessId, (tx) =>
      accountsRepo.deactivateAccount(tx, businessId, revenue!.id),
    );
    const again = await withBusiness(db, businessId, (tx) =>
      accountsRepo.deactivateAccount(tx, businessId, revenue!.id),
    );
    expect(again).toEqual({ outcome: 'already_inactive' });
  });

  it('the database refuses a direct insert citing a deactivated account', async () => {
    const businessId = await seedBusiness();
    const revenue = await byRole(businessId, 'SALES_REVENUE');
    await withBusiness(db, businessId, (tx) =>
      accountsRepo.deactivateAccount(tx, businessId, revenue!.id),
    );

    const refusal = await withBusiness(db, businessId, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO ledger_transactions (business_id, memo, source_type, source_id)
        VALUES (${businessId}::uuid, 'bypass probe', 'manual', 'p1') RETURNING id
      `);
      const txId = [...rows][0]!.id;
      await tx.execute(sql`
        INSERT INTO ledger_entries (business_id, transaction_id, account_id, debit_k, credit_k)
        VALUES (${businessId}::uuid, ${txId}::uuid, ${revenue!.id}::uuid, 0, 100)
      `);
    }).then(
      () => 'inserted',
      (error: unknown) => (error as { cause?: { message?: string } }).cause?.message ?? 'unknown',
    );
    expect(refusal).toMatch(/deactivated/);
  });
});

describe('mandatory roles keep an active account (§11.4)', () => {
  it('refuses to deactivate without a replacement, writing nothing', async () => {
    const businessId = await seedBusiness();
    const ar = await byRole(businessId, 'ACCOUNTS_RECEIVABLE');

    const out = await withBusiness(db, businessId, (tx) =>
      accountsRepo.deactivateAccount(tx, businessId, ar!.id),
    );
    expect(out).toEqual({
      outcome: 'mandatory_needs_replacement',
      role: 'ACCOUNTS_RECEIVABLE',
    });
    expect((await byRole(businessId, 'ACCOUNTS_RECEIVABLE'))!.id).toBe(ar!.id);
  });

  it('retires the predecessor and installs the successor in one transaction', async () => {
    const businessId = await seedBusiness();
    const ar = await byRole(businessId, 'ACCOUNTS_RECEIVABLE');

    const out = await withBusiness(db, businessId, (tx) =>
      accountsRepo.deactivateAccount(tx, businessId, ar!.id, {
        code: '1190',
        name: 'Customer balances',
      }),
    );
    expect(out.outcome).toBe('deactivated');

    /* The engine's contract survives the handover: the role resolves, to
     * the successor, with the same scope and statement placement. */
    const holder = await byRole(businessId, 'ACCOUNTS_RECEIVABLE');
    expect(holder).not.toBeNull();
    expect(holder!.code).toBe('1190');
    expect(holder!.type).toBe(ar!.type);
    expect((await byCode(businessId, '1100'))!.active).toBe(false);
  });

  it('the deferred guard refuses any writer that orphans the role', async () => {
    const businessId = await seedBusiness();

    /* A raw UPDATE around the repo: legal per-statement, refused at the
     * commit it actually exits through. */
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          UPDATE accounts SET active = false, deactivated_at = now()
          WHERE business_id = ${businessId}::uuid AND system_role = 'ACCOUNTS_PAYABLE'
        `),
      ),
    ).rejects.toThrow(/mandatory role ACCOUNTS_PAYABLE/);

    expect(await byRole(businessId, 'ACCOUNTS_PAYABLE')).not.toBeNull();
  });
});

describe('reactivation', () => {
  it('brings a deactivated account back', async () => {
    const businessId = await seedBusiness();
    const revenue = await byRole(businessId, 'SALES_REVENUE');
    await withBusiness(db, businessId, (tx) =>
      accountsRepo.deactivateAccount(tx, businessId, revenue!.id),
    );
    const out = await withBusiness(db, businessId, (tx) =>
      accountsRepo.reactivateAccount(tx, businessId, revenue!.id),
    );
    expect(out).toEqual({ outcome: 'reactivated' });
    expect((await byRole(businessId, 'SALES_REVENUE'))!.id).toBe(revenue!.id);
  });

  it('refuses when a successor holds the role now', async () => {
    const businessId = await seedBusiness();
    const ar = await byRole(businessId, 'ACCOUNTS_RECEIVABLE');
    await withBusiness(db, businessId, (tx) =>
      accountsRepo.deactivateAccount(tx, businessId, ar!.id, {
        code: '1190',
        name: 'Customer balances',
      }),
    );
    const out = await withBusiness(db, businessId, (tx) =>
      accountsRepo.reactivateAccount(tx, businessId, ar!.id),
    );
    expect(out).toEqual({ outcome: 'role_occupied' });
  });
});

describe('the unposted delete (§11.4)', () => {
  it('deletes an account nobody ever posted into', async () => {
    const businessId = await seedBusiness();
    const created = await withBusiness(db, businessId, (tx) =>
      accountsRepo.createAccount(tx, {
        businessId,
        code: '8000',
        name: 'Sundry',
        type: 'expense',
      }),
    );
    const out = await withBusiness(db, businessId, (tx) =>
      accountsRepo.deleteAccount(tx, businessId, created.id),
    );
    expect(out).toEqual({ outcome: 'deleted' });
    expect(await byCode(businessId, '8000')).toBeNull();
  });

  it('refuses, always, once postings exist', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      journalRepo.recordJournal(tx, {
        businessId,
        memo: 'till to bank',
        amountK: 100_000,
        intoAccount: 'BANK',
        outOfAccount: 'CASH',
        actor: 'user:test',
      }),
    );
    const bank = await byCode(businessId, '1020');
    const out = await withBusiness(db, businessId, (tx) =>
      accountsRepo.deleteAccount(tx, businessId, bank!.id),
    );
    expect(out).toEqual({ outcome: 'has_postings' });
  });

  it('refuses to delete the only account a mandatory role has', async () => {
    const businessId = await seedBusiness();
    const vat = await byRole(businessId, 'VAT_PAYABLE');
    const out = await withBusiness(db, businessId, (tx) =>
      accountsRepo.deleteAccount(tx, businessId, vat!.id),
    );
    expect(out).toEqual({ outcome: 'mandatory_role' });
    expect(await byRole(businessId, 'VAT_PAYABLE')).not.toBeNull();
  });
});
