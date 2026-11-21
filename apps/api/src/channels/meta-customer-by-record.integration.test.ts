/**
 * Customer creation follows the record, not where a token landed (owner review of #437 at
 * 3a60b0f): split from meta-customer-token.integration.test.ts by concern.
 */
import { describe, expect, it } from 'vitest';
import { catalogueRepo, conversationsRepo, issueRepo, sql, withBusiness } from '@rekoda/db';
import { db, deps, stubSender, useMetaWebhookHarness } from './meta-webhook.fixtures.js';

import {
  footprint,
  identitiesOf,
  payment,
  plain,
  plaintextIn,
  sale,
  say,
  seedMerchant,
} from './meta-customer-token.fixtures.js';

useMetaWebhookHarness();

/** One ₦100,000 unpaid invoice to `token`. */
async function invoiceTo(businessId: string, token: string) {
  await withBusiness(db, businessId, (tx) =>
    issueRepo.issueSale(tx, {
      businessId,
      customerId: null,
      customerToken: token,
      items: [{ name: 'wig', quantity: 2, unitPriceK: 5_000_000 }],
      subtotalK: 10_000_000,
      discountK: 0,
      deliveryFeeK: 0,
      vatK: 0,
      totalK: 10_000_000,
      paidK: 0,
      balanceDueK: 10_000_000,
      method: 'transfer',
      sourceType: 'chat',
      sourceId: `draft-${token}`,
      actor: 'system',
    }),
  );
}

/** The stock purchases this business saved: amount and supplier, nothing else. */
const purchasesOf = (businessId: string) =>
  withBusiness(db, businessId, (tx) =>
    tx.execute<{ amount_k: string; supplier_id: string | null }>(
      sql`SELECT amount_k::text, supplier_id FROM expenses
           WHERE business_id = ${businessId}::uuid AND category = 'stock'`,
    ),
  ).then((rows) => [...rows]);

/**
 * Customer creation follows the record's meaning, not where a token landed (owner
 * review of #437 at 3a60b0f). Only the customer of a sale, payment or order is a
 * customer; a phone or email anywhere else in a record's words is kept out of the
 * books as [phone] or [email] and creates nobody. The one exception is PR #77's
 * owner rule: a second facet typed beside a record's customer is ASKED about in the
 * preview ("same customer?"), so it is created only where that question is asked.
 */
describe('customer creation follows the record, not the token (owner review of #437)', () => {
  it('a supplier phone on a purchase creates no customer', async () => {
    const business = await seedMerchant();

    await say(
      'wamid.S1',
      {
        intent: 'RecordPurchase',
        supplierMention: 'Musa CUSTOMER_U01',
        description: 'cement from CUSTOMER_U01',
        amount: 40_000,
        reportedPayment: 40_000,
        paymentMethod: 'cash',
        productMention: null,
        quantity: null,
        supplierReference: null,
      },
      'bought cement from Musa 08039998888 for 40k cash',
    );
    expect(stubSender.lastText).not.toContain('CUSTOMER_');
    /* A usable supplier name is still shown, exactly as it is stored (`supplierNameOf`). */
    expect(stubSender.lastText).toContain('From: Musa\n');
    await plain('wamid.S1-yes', 'yes');

    /* The purchase itself is saved, once, for its amount: the checks below are not vacuous. */
    expect((await purchasesOf(business.id)).map((p) => p.amount_k)).toEqual(['4000000']);
    expect((await footprint(business.id)).customers).toBe(0);
    expect(await identitiesOf(business.id)).toEqual([]);
    expect(await plaintextIn(business.id, ['8039998888', 'CUSTOMER_U'])).toEqual([]);
  });

  /* Two phones and a comma leave only punctuation: no "From:" line, and no supplier (CodeRabbit on
   * #437 at ce75a9e). */
  it('a supplier given only as two phone numbers names no supplier', async () => {
    const business = await seedMerchant();
    await say(
      'wamid.S8p',
      {
        intent: 'RecordPurchase',
        supplierMention: 'CUSTOMER_U01, CUSTOMER_U02',
        description: 'cement',
        amount: 40_000,
        reportedPayment: 40_000,
        paymentMethod: 'cash',
        productMention: null,
        quantity: null,
        supplierReference: null,
      },
      'bought cement from 08039998888, 08037776666 for 40k cash',
    );
    expect(stubSender.lastText).not.toContain('From:');
    await plain('wamid.S8p-yes', 'yes');
    expect(await purchasesOf(business.id)).toEqual([{ amount_k: '4000000', supplier_id: null }]);
  });

  it('suppliers known only by phone are never merged into one supplier called [phone]', async () => {
    const business = await seedMerchant();
    /* A different amount each time, so the same-purchase question (G-81) never stands in for a save. */
    const purchase = (supplierMention: string, amount: number) => ({
      intent: 'RecordPurchase',
      supplierMention,
      description: 'cement',
      amount,
      reportedPayment: amount,
      paymentMethod: 'cash',
      productMention: null,
      quantity: null,
      supplierReference: null,
    });

    await say(
      'wamid.S9a',
      purchase('CUSTOMER_U01', 40_000),
      'bought cement from 08039998888 for 40k cash',
    );
    await plain('wamid.S9a-yes', 'yes');
    await say(
      'wamid.S9b',
      purchase('CUSTOMER_U01', 41_000),
      'bought cement from 08037776666 for 41k cash',
    );
    await plain('wamid.S9b-yes', 'yes');
    await say(
      'wamid.S9c',
      purchase('Musa CUSTOMER_U01', 42_000),
      'bought cement from Musa 08035554444 for 42k cash',
    );
    await plain('wamid.S9c-yes', 'yes');

    const suppliers = await withBusiness(
      db,
      business.id,
      async (tx) =>
        [
          ...(await tx.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM suppliers WHERE business_id = ${business.id}::uuid`,
          )),
        ][0]!.n,
    );
    /* Musa is one supplier; the two known only by number are none, never one shared. */
    expect(suppliers).toBe(1);
    /* And that one is Musa's: only his purchase points at a supplier (CodeRabbit on #437). */
    const linked = await withBusiness(db, business.id, async (tx) => [
      ...(await tx.execute<{ linked: boolean }>(
        sql`SELECT supplier_id IS NOT NULL AS linked FROM expenses
             WHERE business_id = ${business.id}::uuid ORDER BY created_at`,
      )),
    ]);
    expect(linked.map((r) => r.linked)).toEqual([false, false, true]);
  });

  it('a supplier named only by a customer token is no supplier (CodeRabbit on #437)', async () => {
    const business = await seedMerchant();
    const bola = await deps.gateway.resolveMention(business.id, 'Bola Ige');

    await say(
      'wamid.S11',
      {
        intent: 'RecordPurchase',
        supplierMention: bola.token,
        description: 'cement',
        amount: 40_000,
        reportedPayment: 40_000,
        paymentMethod: 'cash',
        productMention: null,
        quantity: null,
        supplierReference: null,
      },
      'bought cement from Bola Ige for 40k cash',
    );
    /* The preview names no supplier, as the saved purchase has none (CodeRabbit on #437 at
     * 0e12742): it never shows "From: Bola Ige" over a purchase that keeps no supplier. */
    expect(stubSender.lastText).not.toContain('From:');
    expect(stubSender.lastText).not.toContain('Bola');
    await plain('wamid.S11-yes', 'yes');

    const suppliers = await withBusiness(
      db,
      business.id,
      async (tx) =>
        [
          ...(await tx.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM suppliers WHERE business_id = ${business.id}::uuid`,
          )),
        ][0]!.n,
    );
    expect(suppliers).toBe(0);
    /* Saved, with no supplier row, not refused (CodeRabbit on #437 at fa62d87). */
    expect(await purchasesOf(business.id)).toEqual([{ amount_k: '4000000', supplier_id: null }]);
  });

  it('a second facet beside a sale customer creates nobody when no preview asks about it', async () => {
    const business = await seedMerchant();

    /* The stated total disagrees with the items, so the answer is an arithmetic
     * question, not a preview, and "same customer?" is never asked. */
    await say(
      'wamid.S10',
      { ...sale({ kind: 'token', token: 'CUSTOMER_U01' }), statedTotal: 90_000 },
      'Ada 08039998888 ada.obi@example.com bought 2 wigs, total 90k',
    );
    expect(stubSender.lastText).not.toContain('same customer');
    expect(await identitiesOf(business.id)).toEqual(['phone']);
  });

  it("a contact in an order's note is not the order's customer", async () => {
    const business = await seedMerchant();
    const bola = await deps.gateway.resolveMention(business.id, 'Bola Ige');
    /* Priced, so the order reaches its preview: an unpriced one stops at a question before any
     * link could be asked about, and would pass this test for the wrong reason (CodeRabbit). */
    await withBusiness(db, business.id, (tx) =>
      catalogueRepo.createProduct(tx, business.id, { name: 'wig', unitPriceK: 5_000_000 }),
    );

    await say(
      'wamid.S2',
      {
        intent: 'RecordOrder',
        customer: { kind: 'token', token: bola.token },
        items: [{ name: 'wig', quantity: 1 }],
        note: 'deliver to her cousin CUSTOMER_U01',
      },
      'Bola Ige wants 1 wig, deliver to her cousin 08039998888',
    );

    expect(stubSender.lastText).toContain('raise the invoice');
    expect(stubSender.lastText).not.toContain('same customer');
    expect((await footprint(business.id)).customers).toBe(1);
    expect(await identitiesOf(business.id)).toEqual([]);
    expect(await plaintextIn(business.id, ['8039998888', 'CUSTOMER_U'])).toEqual([]);
  });

  it("a known customer's phone pays against that customer's invoice and creates nobody", async () => {
    const business = await seedMerchant();
    const known = await deps.gateway.tokenise(business.id, 'call 08039998888');
    const token = [...known.tokens.keys()].find((t) => t.startsWith('CUSTOMER_'))!;
    await invoiceTo(business.id, token);
    /* A second open invoice, another customer's: a handler that dropped the phone's token would
     * not know which to pay, or would pay the wrong one (CodeRabbit). */
    const bola = await deps.gateway.resolveMention(business.id, 'Bola Ige');
    await invoiceTo(business.id, bola.token);
    const before = await footprint(business.id);

    await say('wamid.S3', payment({ kind: 'token', token }), '08039998888 paid 20k cash');
    expect(stubSender.lastText).not.toContain('could not tell which customer');
    await plain('wamid.S3-yes', 'yes');

    expect(await footprint(business.id)).toMatchObject({
      customers: before.customers,
      payments: before.payments + 1,
    });
    const paid = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ token: string }>(sql`
        SELECT i.snapshot_json ->> 'customerToken' AS token
          FROM payment_allocations a JOIN invoices i ON i.id = a.invoice_id
         WHERE i.business_id = ${business.id}::uuid`),
    );
    expect([...paid].map((r) => r.token)).toEqual([token]);
  });

  it('a payment from an unknown phone becomes that one customer, never two', async () => {
    const business = await seedMerchant();

    await say(
      'wamid.S4',
      payment({ kind: 'token', token: 'CUSTOMER_U01' }),
      '08039998888 paid 20k cash',
    );

    expect((await footprint(business.id)).customers).toBe(1);
    expect(await identitiesOf(business.id)).toEqual(['phone']);
    const draft = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.pendingDraftToAnswer(tx, business.id, { asOf: new Date() }),
    );
    expect(JSON.stringify(draft?.command ?? {})).not.toContain('CUSTOMER_U');
  });

  it('an invoice to an unknown email is issued to the customer that email became', async () => {
    const business = await seedMerchant();

    await say(
      'wamid.S5',
      sale({ kind: 'token', token: 'CUSTOMER_U01' }),
      'sold 2 wigs to ada.obi@example.com for 100k, she will pay later',
    );
    expect(await identitiesOf(business.id)).toEqual(['email']);
    await plain('wamid.S5-yes', 'yes');

    expect(await footprint(business.id)).toMatchObject({ customers: 1, invoices: 1 });
    const [row] = [
      ...(await withBusiness(db, business.id, (tx) =>
        tx.execute<{ token: string; due: string; linked: boolean }>(
          sql`SELECT i.snapshot_json ->> 'customerToken' AS token, i.balance_due_k::text AS due,
                     (i.customer_id = ci.customer_id AND c.token = i.snapshot_json ->> 'customerToken')
                       AS linked
                FROM invoices i
                JOIN customer_identities ci ON ci.business_id = i.business_id AND ci.facet = 'email'
                JOIN customers c ON c.id = ci.customer_id
               WHERE i.business_id = ${business.id}::uuid`,
        ),
      )),
    ];
    expect(row?.token).toMatch(/^CUSTOMER_[0-9A-Z]{3,}$/);
    expect(row?.token).not.toMatch(/^CUSTOMER_U/);
    expect(row?.due).toBe('10000000');
    // Linked to the customer that email became, not only stamped with a token-shaped value.
    expect(row?.linked).toBe(true);
    expect(await plaintextIn(business.id, ['ada.obi@example.com', 'CUSTOMER_U'])).toEqual([]);
  });

  it("another customer's real token copied into a record's words is not kept", async () => {
    const business = await seedMerchant();
    const bola = await deps.gateway.resolveMention(business.id, 'Bola Ige');

    await say(
      'wamid.S6',
      {
        intent: 'RecordExpense',
        description: `transport for ${bola.token}`,
        amount: 3_000,
        category: 'transport',
        paymentMethod: 'cash',
      },
      'paid 3k cash for transport',
    );
    const draft = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.pendingDraftToAnswer(tx, business.id, { asOf: new Date() }),
    );
    expect((draft?.command as { description?: string }).description).toBe(
      'transport for [customer]',
    );
    expect(stubSender.lastText).not.toContain('Bola');
  });

  it('a phone and an email typed for one sale customer are still asked about (PR #77)', async () => {
    const business = await seedMerchant();

    await say(
      'wamid.S7',
      sale({ kind: 'token', token: 'CUSTOMER_U01' }),
      'Ada 08039998888 ada.obi@example.com bought 2 wigs for 100k',
    );

    expect(stubSender.lastText).toContain('same customer');
    expect(await identitiesOf(business.id)).toEqual(['email', 'phone']);
  });

  it('a second phone beside a known customer on a payment creates nobody', async () => {
    const business = await seedMerchant();
    const bola = await deps.gateway.resolveMention(business.id, 'Bola Ige');
    await invoiceTo(business.id, bola.token);

    await say(
      'wamid.S8',
      payment({ kind: 'token', token: bola.token }),
      'Bola Ige paid 20k, her driver is 08039998888 and 08037776666',
    );

    // The payment reached its preview (a refusal before linking would pass for the wrong reason).
    expect(stubSender.lastText).toContain('Payment on INV-');
    expect(stubSender.lastText).not.toContain('same customer');
    expect(await identitiesOf(business.id)).toEqual([]);
  });
});
