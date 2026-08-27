/**
 * The customer-credit subledger (spec §14.1; PR-048): a credit is created
 * once per source event, its balance is derived and never a column, an
 * unapplied credit reduces nothing until explicitly applied, and the
 * credit does not stretch. Everything append-only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  customerCreditsRepo,
  settleRepo,
  customersRepo,
  identity,
  issueRepo,
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
  const user = await identity.upsertUserByPhone(db, `+23481850${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

async function seedCustomerAndInvoice(businessId: string) {
  const customer = await customersRepo.createCustomerWithIdentities(
    db,
    businessId,
    `CUSTOMER_X${seq}`,
    [],
  );
  const sale = await withBusiness(db, businessId, (tx) =>
    issueRepo.issueSale(tx, {
      businessId,
      customerId: customer.id,
      customerToken: customer.token,
      items: [{ name: 'wig', quantity: 1, unitPriceK: 100_000 }],
      subtotalK: 100_000,
      discountK: 0,
      deliveryFeeK: 0,
      vatK: 0,
      totalK: 100_000,
      paidK: 0,
      balanceDueK: 100_000,
      method: 'transfer',
      sourceType: 'chat',
      sourceId: `draft-cc-${seq}`,
      saleSource: null,
      dueDate: null,
      actor: 'system',
    }),
  );
  return { customerId: customer.id, invoiceId: sale.invoiceId };
}

describe('one event, one credit (§14.1)', () => {
  it('grants once per source and derives the balance', async () => {
    const businessId = await seedBusiness();
    const { customerId } = await seedCustomerAndInvoice(businessId);

    const granted = await withBusiness(db, businessId, (tx) =>
      customerCreditsRepo.grantCustomerCredit(tx, {
        businessId,
        customerId,
        amountMinor: 21_500,
        sourceType: 'credit_note',
        sourceId: 'CRN-2026-0001',
        reason: 'returned goods',
      }),
    );
    expect(granted.outcome).toBe('granted');

    const replay = await withBusiness(db, businessId, (tx) =>
      customerCreditsRepo.grantCustomerCredit(tx, {
        businessId,
        customerId,
        amountMinor: 21_500,
        sourceType: 'credit_note',
        sourceId: 'CRN-2026-0001',
      }),
    );
    expect(replay).toEqual({ outcome: 'already_granted' });

    expect(
      await withBusiness(db, businessId, (tx) =>
        customerCreditsRepo.customerCreditBalanceMinor(tx, businessId, customerId),
      ),
    ).toBe(21_500);
  });

  it('a zero or negative credit is unrepresentable', async () => {
    const businessId = await seedBusiness();
    const { customerId } = await seedCustomerAndInvoice(businessId);
    await expect(
      withBusiness(db, businessId, (tx) =>
        customerCreditsRepo.grantCustomerCredit(tx, {
          businessId,
          customerId,
          amountMinor: 0,
          sourceType: 'overpayment',
          sourceId: 'pay-z',
        }),
      ),
    ).rejects.toThrow();
  });

  it("a credit cannot cite another tenant's customer", async () => {
    const ada = await seedBusiness();
    const bola = await seedBusiness();
    const { customerId: bolaCustomer } = await seedCustomerAndInvoice(bola);
    await expect(
      withBusiness(db, ada, (tx) =>
        customerCreditsRepo.grantCustomerCredit(tx, {
          businessId: ada,
          customerId: bolaCustomer,
          amountMinor: 100,
          sourceType: 'overpayment',
          sourceId: 'x',
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('explicit application, derived remainder', () => {
  it('applies within the balance and refuses beyond it, writing nothing', async () => {
    const businessId = await seedBusiness();
    const { customerId, invoiceId } = await seedCustomerAndInvoice(businessId);
    const granted = await withBusiness(db, businessId, (tx) =>
      customerCreditsRepo.grantCustomerCredit(tx, {
        businessId,
        customerId,
        amountMinor: 21_500,
        sourceType: 'credit_note',
        sourceId: 'CRN-2026-0002',
      }),
    );
    if (granted.outcome !== 'granted') throw new Error('fixture');

    const applied = await withBusiness(db, businessId, (tx) =>
      customerCreditsRepo.applyCustomerCredit(tx, {
        businessId,
        customerCreditId: granted.id,
        invoiceId,
        amountMinor: 15_000,
        sourceType: 'dashboard',
        sourceId: 'apply-1',
      }),
    );
    expect(applied).toMatchObject({ outcome: 'applied', remainingMinor: 6_500 });

    const over = await withBusiness(db, businessId, (tx) =>
      customerCreditsRepo.applyCustomerCredit(tx, {
        businessId,
        customerCreditId: granted.id,
        invoiceId,
        amountMinor: 10_000,
        sourceType: 'dashboard',
        sourceId: 'apply-2',
      }),
    );
    expect(over).toEqual({ outcome: 'insufficient_credit', remainingMinor: 6_500 });
    expect(
      await withBusiness(db, businessId, (tx) =>
        customerCreditsRepo.creditBalanceMinor(tx, businessId, granted.id),
      ),
    ).toBe(6_500);
    expect(
      await withBusiness(db, businessId, (tx) =>
        customerCreditsRepo.creditApplicationsFor(tx, businessId, granted.id),
      ),
    ).toHaveLength(1);
  });

  it('both tables refuse rewrites: the owing and its uses are history', async () => {
    const businessId = await seedBusiness();
    const { customerId, invoiceId } = await seedCustomerAndInvoice(businessId);
    const granted = await withBusiness(db, businessId, (tx) =>
      customerCreditsRepo.grantCustomerCredit(tx, {
        businessId,
        customerId,
        amountMinor: 5_000,
        sourceType: 'overpayment',
        sourceId: 'pay-9',
      }),
    );
    if (granted.outcome !== 'granted') throw new Error('fixture');
    await withBusiness(db, businessId, (tx) =>
      customerCreditsRepo.applyCustomerCredit(tx, {
        businessId,
        customerCreditId: granted.id,
        invoiceId,
        amountMinor: 5_000,
        sourceType: 'dashboard',
        sourceId: 'apply-3',
      }),
    );
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(
          sql`UPDATE customer_credits SET amount_minor = 1 WHERE business_id = ${businessId}::uuid`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(
          sql`DELETE FROM customer_credit_applications WHERE business_id = ${businessId}::uuid`,
        ),
      ),
    ).rejects.toThrow();
  });
});

describe('one full reversal (§14.2; PR-049)', () => {
  async function appliedFixture() {
    const businessId = await seedBusiness();
    const { customerId, invoiceId } = await seedCustomerAndInvoice(businessId);
    const granted = await withBusiness(db, businessId, (tx) =>
      customerCreditsRepo.grantCustomerCredit(tx, {
        businessId,
        customerId,
        amountMinor: 20_000,
        sourceType: 'credit_note',
        sourceId: 'CRN-rev',
      }),
    );
    if (granted.outcome !== 'granted') throw new Error('fixture');
    const applied = await withBusiness(db, businessId, (tx) =>
      customerCreditsRepo.applyCustomerCredit(tx, {
        businessId,
        customerCreditId: granted.id,
        invoiceId,
        amountMinor: 20_000,
        sourceType: 'dashboard',
        sourceId: 'apply-rev',
      }),
    );
    if (applied.outcome !== 'applied') throw new Error('fixture');
    return { businessId, creditId: granted.id, applicationId: applied.id, invoiceId };
  }

  it('reverses exactly once, restores the balance, and refuses reversing a reversal', async () => {
    const { businessId, creditId, applicationId } = await appliedFixture();
    expect(
      await withBusiness(db, businessId, (tx) =>
        customerCreditsRepo.creditBalanceMinor(tx, businessId, creditId),
      ),
    ).toBe(0);

    const reversed = await withBusiness(db, businessId, (tx) =>
      customerCreditsRepo.reverseCreditApplication(tx, {
        businessId,
        applicationId,
        reason: 'applied to the wrong invoice',
        sourceType: 'dashboard',
        sourceId: 'rev-1',
      }),
    );
    expect(reversed.outcome).toBe('reversed');
    expect(
      await withBusiness(db, businessId, (tx) =>
        customerCreditsRepo.creditBalanceMinor(tx, businessId, creditId),
      ),
    ).toBe(20_000);

    expect(
      await withBusiness(db, businessId, (tx) =>
        customerCreditsRepo.reverseCreditApplication(tx, {
          businessId,
          applicationId,
          reason: 'twice',
          sourceType: 'dashboard',
          sourceId: 'rev-2',
        }),
      ),
    ).toEqual({ outcome: 'already_reversed' });

    if (reversed.outcome !== 'reversed') return;
    expect(
      await withBusiness(db, businessId, (tx) =>
        customerCreditsRepo.reverseCreditApplication(tx, {
          businessId,
          applicationId: reversed.id,
          reason: 'reversal of a reversal',
          sourceType: 'dashboard',
          sourceId: 'rev-3',
        }),
      ),
    ).toEqual({ outcome: 'is_a_reversal' });
  });

  it('the trigger refuses a partial or shapeless reversal outright', async () => {
    const { businessId, creditId, applicationId, invoiceId } = await appliedFixture();
    /* Partial negation: "at most one reversal" plus partial amounts would
     * strand the remainder permanently and silently. */
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO customer_credit_applications
            (business_id, customer_credit_id, invoice_id, amount_minor, currency,
             reversal_of_id, reason, source_type, source_id)
          VALUES (${businessId}::uuid, ${creditId}::uuid, ${invoiceId}::uuid,
                  -10000, 'NGN', ${applicationId}::uuid, 'half-hearted', 'raw', 'r1')
        `),
      ),
    ).rejects.toThrow();
    /* A reversal without a reason is not one. */
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO customer_credit_applications
            (business_id, customer_credit_id, invoice_id, amount_minor, currency,
             reversal_of_id, source_type, source_id)
          VALUES (${businessId}::uuid, ${creditId}::uuid, ${invoiceId}::uuid,
                  -20000, 'NGN', ${applicationId}::uuid, 'raw', 'r2')
        `),
      ),
    ).rejects.toThrow();
    /* A bare negative row that reverses nothing is unrepresentable. */
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO customer_credit_applications
            (business_id, customer_credit_id, invoice_id, amount_minor, currency, source_type, source_id)
          VALUES (${businessId}::uuid, ${creditId}::uuid, ${invoiceId}::uuid,
                  -5000, 'NGN', 'raw', 'r3')
        `),
      ),
    ).rejects.toThrow();
  });
});

describe('payment allocations under the same law (§14.2; PR-049)', () => {
  it('a merchant payment allocation reverses once, exactly, and never twice', async () => {
    const businessId = await seedBusiness();
    const { invoiceId } = await seedCustomerAndInvoice(businessId);
    await withBusiness(db, businessId, (tx) =>
      settleRepo.recordMerchantPayment(tx, {
        businessId,
        invoiceId,
        amountK: 100_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'draft-alloc',
        actor: 'system',
      }),
    );
    const allocations = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ id: string; amount_k: string }>(
        sql`SELECT id, amount_k::bigint AS amount_k FROM payment_allocations
            WHERE business_id = ${businessId}::uuid`,
      ),
    );
    const allocation = [...allocations][0]!;

    const reversed = await withBusiness(db, businessId, (tx) =>
      settleRepo.reverseAllocation(tx, {
        businessId,
        allocationId: allocation.id,
        reason: 'matched to the wrong invoice',
        sourceType: 'dashboard',
        sourceId: 'realloc-1',
      }),
    );
    expect(reversed.outcome).toBe('reversed');

    expect(
      await withBusiness(db, businessId, (tx) =>
        settleRepo.reverseAllocation(tx, {
          businessId,
          allocationId: allocation.id,
          reason: 'twice',
          sourceType: 'dashboard',
          sourceId: 'realloc-2',
        }),
      ),
    ).toEqual({ outcome: 'already_reversed' });

    /* Net allocation for the payment is now zero, by rows, not edits. */
    const net = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ net: string }>(
        sql`SELECT COALESCE(SUM(amount_k), 0)::bigint AS net FROM payment_allocations
            WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect(Number([...net][0]!.net)).toBe(0);

    /* And nothing mutates: allocations are append-only now. */
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`DELETE FROM payment_allocations WHERE business_id = ${businessId}::uuid`),
      ),
    ).rejects.toThrow();
  });
});
