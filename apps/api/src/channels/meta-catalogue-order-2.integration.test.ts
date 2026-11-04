/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: a catalogue cart becomes an order (spec §3.2; W3, PR-087) (part 2 of 2).
 * Split by concern from meta.integration.test.ts; the shared app, stubs and payload helpers are
 * in meta-webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { catalogueRepo, stockRepo, withBusiness, sql } from '@rekoda/db';
import { placeCatalogueOrderWork, validateCatalogueOrderWork } from '../commands/order-commands.js';
import { buildRunner } from '../jobs/jobs.module.js';
import { paymentsHub } from '@rekoda/db';
import {
  db,
  deps,
  orderPayload,
  post,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';
import { seedCommerceMerchant, ordersOf } from './meta-catalogue-order.fixtures.js';

useMetaWebhookHarness();

describe('a catalogue cart becomes an order (spec §3.2; W3, PR-087)', () => {
  it('refuses a cart the counted shelf cannot serve, leaving the order visibly cancelled', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002224', 'PN-CART-4');
    await withBusiness(db, businessId, async (tx) => {
      const wig = (await stockRepo.productByName(tx, businessId, 'wig'))!;
      await stockRepo.recordDelivery(tx, {
        businessId,
        product: wig,
        quantity: 1,
        costK: 20_000,
        sourceType: 'chat',
      });
    });

    await post(
      orderPayload('2349097774444', 'wamid.CART.4', 'PN-CART-4', [
        { retailerId: wigId, quantity: 3 },
      ]),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* The request stands, visibly refused; nothing financial exists. */
    const refused = [...(await ordersOf(businessId))];
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ status: 'cancelled', invoice_id: null });
    const ledger = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: string }>(
        sql`SELECT COUNT(*) AS n FROM ledger_entries WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect([...ledger][0]!.n).toBe('0');
  });

  it('a counted shelf serves the cart, commits the goods, and the fee lands as a record', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002225', 'PN-CART-5');
    await withBusiness(db, businessId, async (tx) => {
      const wig = (await stockRepo.productByName(tx, businessId, 'wig'))!;
      await stockRepo.recordDelivery(tx, {
        businessId,
        product: wig,
        quantity: 5,
        costK: 100_000,
        sourceType: 'chat',
      });
      await paymentsHub.upsertConnection(tx, { businessId, providerType: 'paystack' });
    });

    await post(
      orderPayload('2349097775555', 'wamid.CART.5', 'PN-CART-5', [
        { retailerId: wigId, quantity: 2 },
      ]),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* Goods committed at their cost: 2 off the shelf, COGS 2 × 20,000. */
    const shelf = await withBusiness(db, businessId, (tx) =>
      stockRepo.productByName(tx, businessId, 'wig'),
    );
    expect(shelf).toMatchObject({ onHand: 3 });
    const cogs = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ k: string }>(sql`
        SELECT COALESCE(SUM(e.debit_k), 0)::bigint AS k
        FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE e.business_id = ${businessId}::uuid AND a.code = '5000'
      `),
    );
    expect([...cogs][0]!.k).toBe('40000');

    /* §19.1: the provider's expected fee is a RECORD — estimated from the
     * rate card of the mechanism actually used, merchant-borne, and per §19.1
     * becomes actual once settled (G-116: `resolveOrderProcessingFee`). The live mechanism is
     * Pay-with-Transfer, which is Paystack's LOCAL rate (1.5% + ₦100, capped ₦2,000, the ₦100 waived under
     * ₦2,500), not the DVA rate (G-22, ADR 0016). A ₦3,000 order clears the
     * waiver: 1.5% of 300,000 kobo = 4,500, plus 10,000 flat = 14,500. */
    const charges = await withBusiness(db, businessId, (tx) =>
      tx.execute<{
        type: string;
        amount_minor: string;
        beneficiary: string;
        economic_bearer: string;
        actual_or_estimated: string;
      }>(sql`
        SELECT type, amount_minor::bigint AS amount_minor, beneficiary, economic_bearer,
               actual_or_estimated
        FROM payment_charges WHERE business_id = ${businessId}::uuid
      `),
    );
    expect([...charges]).toEqual([
      {
        type: 'PAYMENT_PROCESSING',
        amount_minor: '14500',
        beneficiary: 'PROVIDER',
        economic_bearer: 'MERCHANT',
        actual_or_estimated: 'ESTIMATED',
      },
    ]);
  });

  /* G-22 / ADR 0016: the ADR's own worked example. A ₦105,000 order through
   * Pay-with-Transfer is ₦1,675 (1.5% = ₦1,575, plus ₦100), not the ₦300 a DVA
   * would cost. */
  it('estimates the ADR 0016 example: a ₦105,000 order carries a ₦1,675 processing charge (G-22)', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002229', 'PN-FEE-1');
    await withBusiness(db, businessId, (tx) =>
      paymentsHub.upsertConnection(tx, { businessId, providerType: 'paystack' }),
    );

    expect(
      (
        await post(
          orderPayload('2349097771129', 'wamid.FEE.1', 'PN-FEE-1', [
            /* 70 × ₦1,500 = ₦105,000. */
            { retailerId: wigId, quantity: 70, liedPriceK: 1 },
          ]),
        )
      ).statusCode,
    ).toBe(200);
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    const charges = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ amount_minor: string }>(sql`
        SELECT amount_minor::bigint AS amount_minor FROM payment_charges
        WHERE business_id = ${businessId}::uuid AND type = 'PAYMENT_PROCESSING'
      `),
    );
    expect([...charges].map((c) => c.amount_minor)).toEqual(['167500']);
  });

  it('a price moved between placement and validation refuses rather than re-quotes', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002226', 'PN-CART-6');

    const rejected = await withBusiness(db, businessId, async (tx) => {
      const placed = await placeCatalogueOrderWork(tx, {
        businessId,
        customerId: null,
        lines: [
          { productId: wigId, name: 'wig', quantity: 1, unitPriceK: 150_000, lineTotalK: 150_000 },
        ],
        totalK: 150_000,
        externalRef: 'meta:wamid.CART.6',
        sourceId: 'wamid.CART.6',
      });
      /* The merchant moves the price while the order sits PLACED. */
      await catalogueRepo.editProduct(tx, businessId, wigId, { unitPriceK: 175_000 });
      return validateCatalogueOrderWork(tx, {
        businessId,
        orderId: placed.orderId,
        actor: 'customer:waba',
      });
    });
    expect(rejected).toEqual({ outcome: 'rejected', reason: 'price_changed' });
    expect([...(await ordersOf(businessId))][0]).toMatchObject({
      status: 'cancelled',
      invoice_id: null,
    });
  });

  it('refuses the WHOLE cart when it names an item the shelf does not sell', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002223', 'PN-CART-3');

    await post(
      orderPayload('2349097773333', 'wamid.CART.3', 'PN-CART-3', [
        { retailerId: wigId, quantity: 1 },
        { retailerId: '00000000-0000-4000-8000-000000000000', quantity: 1 },
      ]),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* No partial order: a customer shown an order they did not compose
     * would pay for a guess. The message still landed on their thread. */
    expect([...(await ordersOf(businessId))]).toHaveLength(0);
  });

  it('refuses a cart naming a SKU rather than crashing on it (remediation R3)', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002224', 'PN-CART-4');

    /* A merchant whose Meta catalog was built outside Rekoda sends their own
     * SKU. It reached `inArray(products.id, ...)` on a uuid column, so the
     * job died with `invalid input syntax for type uuid` and the customer
     * heard nothing at all. A string nothing matches is a refusal. */
    await post(
      orderPayload('2349097773444', 'wamid.CART.4', 'PN-CART-4', [
        { retailerId: wigId, quantity: 1 },
        { retailerId: 'BLACK-SHOE-XL', quantity: 1 },
      ]),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect([...(await ordersOf(businessId))]).toHaveLength(0);
    /* The job finished. A crash would have left it pending for a retry that
     * fails the same way five times. */
    const live = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM jobs
               WHERE business_id = ${businessId}::uuid AND state <> 'done'`,
        ),
      )),
    ];
    expect(live[0]!.n).toBe('0');
  });

  it("prices a cart off the merchant's own SKU when the shelf carries one", async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002225', 'PN-CART-5');
    await withBusiness(db, businessId, (tx) =>
      tx.execute(
        sql`UPDATE products SET external_catalogue_id = 'WIG-001'
             WHERE business_id = ${businessId}::uuid AND id = ${wigId}::uuid`,
      ),
    );

    await post(
      orderPayload('2349097773555', 'wamid.CART.5R3', 'PN-CART-5', [
        { retailerId: 'WIG-001', quantity: 2 },
      ]),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    const placed = [...(await ordersOf(businessId))];
    expect(placed).toHaveLength(1);
    /* 2 x the merchant's own 150,000, read off their row as always. */
    expect(placed[0]).toMatchObject({ total_k: '300000', external_ref: 'meta:wamid.CART.5R3' });
  });
});
