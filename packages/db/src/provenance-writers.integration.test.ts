/**
 * Every writer stamps provenance at birth (spec §6.2–6.3; PR-005).
 *
 * The three payment writers established by R0A-i — bookVerifiedPayment,
 * recordMerchantPayment, and issueSale's paid branch — each set
 * `initialConfirmationSource`, normalise the instrument into `paymentMethod`,
 * and append exactly one PaymentVerification with its claim, in one
 * transaction. From this PR forward, no NEW payment's provenance is
 * unknowable; the backfill of the old ones is PR-006's and waits on the
 * approved report.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { paymentReference } from '@rekoda/core';
import { createDb, withBusiness, type Db, type TenantDb } from './client.js';
import { identity, issueRepo, paymentsHub, settleRepo } from './index.js';
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

async function seedBusiness(): Promise<string> {
  const user = await identity.upsertUserByPhone(db, '+2348130000001');
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** An unpaid invoice and a live intent covering it, as the estate makes them. */
async function seedObligation(businessId: string, draft = 'draft-1') {
  return withBusiness(db, businessId, async (tx) => {
    const sale = await issueRepo.issueSale(tx, {
      businessId,
      customerId: null,
      customerToken: 'CUSTOMER_7K2',
      items: [{ name: 'wig', quantity: 3, unitPriceK: 5_000_000 }],
      subtotalK: 15_000_000,
      discountK: 0,
      deliveryFeeK: 0,
      vatK: 0,
      totalK: 15_000_000,
      paidK: 0,
      balanceDueK: 15_000_000,
      method: 'transfer',
      sourceType: 'chat',
      sourceId: draft,
      actor: 'system',
    });
    const intent = await paymentsHub.createIntent(tx, {
      businessId,
      reference: paymentReference(new Date(), (n) => randomBytes(n)),
      expectedAmountK: 15_000_000,
      providerType: 'paystack',
      invoiceId: sale.invoiceId,
    });
    return { sale, intent };
  });
}

async function book(
  tx: TenantDb,
  businessId: string,
  intent: paymentsHub.IntentRow,
  overrides: Partial<settleRepo.BookVerifiedPaymentInput> = {},
) {
  /* A REAL connection: since PR-054 the attempt row holds a tenant-safe FK
   * to it, so a made-up id is (rightly) unrepresentable. */
  const connection = await paymentsHub.upsertConnection(tx, {
    businessId,
    providerType: 'paystack',
  });
  return settleRepo.bookVerifiedPayment(tx, {
    businessId,
    intent: {
      id: intent.id,
      reference: intent.reference,
      invoiceId: intent.invoiceId,
      customerId: intent.customerId,
    },
    confirmedAmountK: 15_000_000,
    currency: 'NGN',
    providerType: 'paystack',
    providerRef: `pst-${randomBytes(4).toString('hex')}`,
    providerStatus: 'success',
    providerFeeK: 0,
    feePolicy: 'merchant_bearing',
    method: 'transfer',
    paymentConnectionId: connection.id,
    actor: 'system:payments',
    eventId: 'event-1',
    ...overrides,
  });
}

async function provenanceOf(businessId: string, paymentId: string) {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{
      initial_confirmation_source: string | null;
      payment_method: string | null;
      method: string;
      source: string | null;
      actor_id: string | null;
      claim_key: string | null;
    }>(sql`
      SELECT p.initial_confirmation_source, p.payment_method, p.method,
             v.source, v.actor_id, c.confirmation_event_id AS claim_key
      FROM payments p
      LEFT JOIN payment_verifications v ON v.payment_id = p.id
      LEFT JOIN payment_verification_claims c ON c.verification_id = v.id
      WHERE p.id = ${paymentId}::uuid
    `),
  );
  return [...rows];
}

describe('bookVerifiedPayment', () => {
  it('stamps PROVIDER_VERIFIED and appends the verification with its claim', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const booked = await withBusiness(db, businessId, (tx) =>
      book(tx, businessId, intent, { providerRef: 'pst-abc123' }),
    );

    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{
        initial_confirmation_source: string;
        payment_method: string;
        source: string;
        provider_source_identity: string;
      }>(sql`
        SELECT p.initial_confirmation_source, p.payment_method,
               v.source, c.provider_source_identity
        FROM payments p
        JOIN payment_verifications v ON v.payment_id = p.id
        JOIN payment_verification_claims c ON c.verification_id = v.id
        WHERE p.id = ${booked.paymentId}::uuid
      `),
    );
    expect([...rows][0]).toEqual({
      initial_confirmation_source: 'PROVIDER_VERIFIED',
      payment_method: 'BANK_TRANSFER',
      source: 'PROVIDER_VERIFIED',
      provider_source_identity: expect.stringMatching(/^[0-9a-f-]{36}:pst-abc123$/),
    });
  });

  /**
   * The duplicate the claim exists to stop: two DIFFERENT intents carrying
   * the same provider transaction. The reference index cannot see this one —
   * the references differ — and without the claim both would book, which is
   * the same money counted twice on every report that sums payments.
   */
  it('refuses the same provider transaction booking under two intents', async () => {
    const businessId = await seedBusiness();
    const { intent: first } = await seedObligation(businessId, 'draft-1');
    const { intent: second } = await seedObligation(businessId, 'draft-2');

    await withBusiness(db, businessId, (tx) =>
      book(tx, businessId, first, { providerRef: 'pst-same' }),
    );
    await expect(
      withBusiness(db, businessId, (tx) =>
        book(tx, businessId, second, { providerRef: 'pst-same' }),
      ),
    ).rejects.toThrow();

    /* The whole second transaction rolled back: one payment, not one and a
     * half. */
    const count = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM payments WHERE provider_ref = 'pst-same'`,
      ),
    );
    expect([...count][0]?.n).toBe(1);
  });

  /* Degraded state: no connection row. The identity falls back to the rail's
   * name and the payment still books with full provenance. */
  it('books without a connection id, on the providerType identity', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const booked = await withBusiness(db, businessId, (tx) =>
      book(tx, businessId, intent, { paymentConnectionId: null, providerRef: 'pst-nofk' }),
    );
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ provider_source_identity: string }>(sql`
        SELECT c.provider_source_identity
        FROM payment_verifications v
        JOIN payment_verification_claims c ON c.verification_id = v.id
        WHERE v.payment_id = ${booked.paymentId}::uuid
      `),
    );
    expect([...rows][0]?.provider_source_identity).toBe('paystack:pst-nofk');
  });
});

describe('recordMerchantPayment', () => {
  async function seedInvoice(businessId: string) {
    const { sale } = await seedObligation(businessId, `draft-${randomBytes(3).toString('hex')}`);
    return sale;
  }

  it('stamps MERCHANT_ATTESTED with the actor, and the instrument travels separately', async () => {
    const businessId = await seedBusiness();
    const sale = await seedInvoice(businessId);

    const recorded = await withBusiness(db, businessId, (tx) =>
      settleRepo.recordMerchantPayment(tx, {
        businessId,
        invoiceId: sale.invoiceId,
        amountK: 5_000_000,
        method: 'pos',
        sourceType: 'dashboard',
        sourceId: sale.invoiceNumber,
        actor: 'user:ada',
        clientRef: 'form-1',
      }),
    );

    const rows = await provenanceOf(businessId, recorded.paymentId);
    expect(rows[0]).toMatchObject({
      initial_confirmation_source: 'MERCHANT_ATTESTED',
      /* MERCHANT_ATTESTED + POS is representable now, which it was not while
       * the source enum carried the instrument (spec §6.2). */
      payment_method: 'POS',
      method: 'pos',
      source: 'MERCHANT_ATTESTED',
      actor_id: 'user:ada',
      claim_key: 'dashboard:ref:form-1',
    });
  });

  /**
   * Two partial payments against one invoice are two confirmations, not a
   * retry of one. The invoice number is deliberately NOT the claim identity,
   * and this is the test that keeps it that way.
   */
  it('lets a second partial payment on the same invoice through', async () => {
    const businessId = await seedBusiness();
    const sale = await seedInvoice(businessId);

    const pay = (clientRef: string, amountK: number) =>
      withBusiness(db, businessId, (tx) =>
        settleRepo.recordMerchantPayment(tx, {
          businessId,
          invoiceId: sale.invoiceId,
          amountK,
          method: 'cash',
          sourceType: 'dashboard',
          sourceId: sale.invoiceNumber,
          actor: 'user:ada',
          clientRef,
        }),
      );

    const first = await pay('form-1', 5_000_000);
    const second = await pay('form-2', 5_000_000);
    expect(first.paymentId).not.toBe(second.paymentId);
    expect(second.balanceDueK).toBe(5_000_000);
  });

  /* One confirmation action attests once: the same chat draft cannot attest
   * a second payment, which is what stops a retried job doubling money. */
  it('refuses a second attestation from the same chat confirmation', async () => {
    const businessId = await seedBusiness();
    const sale = await seedInvoice(businessId);

    const attest = () =>
      withBusiness(db, businessId, (tx) =>
        settleRepo.recordMerchantPayment(tx, {
          businessId,
          invoiceId: sale.invoiceId,
          amountK: 2_000_000,
          method: 'transfer',
          sourceType: 'chat',
          sourceId: 'payment-draft-9',
          actor: 'system',
        }),
      );
    await attest();
    await expect(attest()).rejects.toThrow();
  });
});

describe('issueSale, the paid branch', () => {
  it('stamps the payment born with a sale as MERCHANT_ATTESTED', async () => {
    const businessId = await seedBusiness();
    const issued = await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_7K2',
        items: [{ name: 'wig', quantity: 1, unitPriceK: 5_000_000 }],
        subtotalK: 5_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 5_000_000,
        paidK: 5_000_000,
        balanceDueK: 0,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'draft-paid-1',
        actor: 'system',
      }),
    );
    expect(issued.paymentId).not.toBeNull();

    const rows = await provenanceOf(businessId, issued.paymentId!);
    expect(rows[0]).toMatchObject({
      initial_confirmation_source: 'MERCHANT_ATTESTED',
      payment_method: 'CASH',
      source: 'MERCHANT_ATTESTED',
      claim_key: 'chat:draft-paid-1',
    });
  });

  /* An unpaid sale creates no payment and therefore no verification: nothing
   * to attest, and no row pretending otherwise. Existing behaviour, pinned. */
  it('writes no provenance for an unpaid sale, because there is no payment', async () => {
    const businessId = await seedBusiness();
    const issued = await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_7K2',
        items: [{ name: 'wig', quantity: 1, unitPriceK: 5_000_000 }],
        subtotalK: 5_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 5_000_000,
        paidK: 0,
        balanceDueK: 5_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-unpaid-1',
        actor: 'system',
      }),
    );
    expect(issued.paymentId).toBeNull();
    const count = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM payment_verifications`),
    );
    expect([...count][0]?.n).toBe(0);
  });
});

/**
 * The invariant behind all three: every NEW payment carries a non-null
 * initial source and exactly one verification with exactly one claim. The
 * integrity job of spec §6.5 will watch this in production; this is the same
 * question asked of every writer at once.
 */
describe('no new payment is born unknowable', () => {
  it('leaves no payment without provenance and no verification without a claim', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    await withBusiness(db, businessId, (tx) => book(tx, businessId, intent));

    const orphans = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ unstamped: number; unclaimed: number }>(sql`
        SELECT
          (SELECT count(*)::int FROM payments
            WHERE initial_confirmation_source IS NULL) AS unstamped,
          (SELECT count(*)::int FROM payment_verifications v
            WHERE NOT EXISTS (SELECT 1 FROM payment_verification_claims c
                              WHERE c.verification_id = v.id)) AS unclaimed
      `),
    );
    expect([...orphans][0]).toEqual({ unstamped: 0, unclaimed: 0 });
  });
});
