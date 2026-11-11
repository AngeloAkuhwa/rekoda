/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: a catalogue cart becomes an order (spec §3.2; W3, PR-087) (part 1 of 2).
 * Split by concern from meta.integration.test.ts; the shared app, stubs and payload helpers are
 * in meta-webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { createDb, catalogueRepo, usageRepo, withBusiness, sql } from '@rekoda/db';
import { allowanceFor, usagePeriod } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
import {
  db,
  deps,
  invoiceCount,
  orderPayload,
  post,
  urls,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';
import { seedCommerceMerchant, ordersOf } from './meta-catalogue-order.fixtures.js';
import { setPlanForTest } from '@rekoda/db/testing';

useMetaWebhookHarness();

/** Run the queue until a job has failed with `reason`, so the test is never vacuous. */
async function runUntilFailed(businessId: string, reason: string): Promise<number> {
  const runner = buildRunner(workerDb, db, deps);
  const { db: jobsDb, close: closeJobs } = createDb(urls.owner, { max: 1 });
  try {
    for (let pass = 0; pass < 20; pass++) {
      const [row] = [
        ...(await jobsDb.execute<{ n: number }>(sql`
            SELECT count(*)::int AS n FROM jobs WHERE business_id = ${businessId}::uuid
               AND last_error LIKE ${`%${reason}%`}`)),
      ];
      if (Number(row?.n) > 0) return Number(row?.n);
      await runner.runOnce();
    }
    return 0;
  } finally {
    await closeJobs();
  }
}

describe('a catalogue cart becomes an order (spec §3.2; W3, PR-087)', () => {
  it('prices the cart off the merchant’s own rows, never off the message', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002221', 'PN-CART-1');

    /* The device claims each wig costs 1 kobo. */
    expect(
      (
        await post(
          orderPayload('2349097771111', 'wamid.CART.1', 'PN-CART-1', [
            { retailerId: wigId, quantity: 2, liedPriceK: 1 },
          ]),
        )
      ).statusCode,
    ).toBe(200);
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    const placed = [...(await ordersOf(businessId))];
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({
      /* PLACED then VALIDATED in the same transaction (PR-088): the
       * §5.2 validation ran against the real catalogue and real shelf
       * before any figure could be shown. */
      status: 'validated',
      external_ref: 'meta:wamid.CART.1',
      /* 2 × the MERCHANT'S 150,000 — the claimed 1 kobo never existed. */
      total_k: '300000',
    });
    /* The customer exists, anchored on their own phone. */
    expect(placed[0]!.customer_id).not.toBeNull();
    /* Validation issued the invoice: a receivable exists NOW, not before. */
    expect(placed[0]!.invoice_id).not.toBeNull();
    const invoice = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ total_k: string; balance_due_k: string; source_type: string }>(sql`
        SELECT total_k::bigint AS total_k, balance_due_k::bigint AS balance_due_k, source_type
        FROM invoices WHERE business_id = ${businessId}::uuid
      `),
    );
    expect([...invoice]).toEqual([
      { total_k: '300000', balance_due_k: '300000', source_type: 'waba_catalogue' },
    ]);

    /* The lines carry the shelf's names and prices. */
    const lines = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ name: string; unit_price_k: string; quantity: number }>(sql`
        SELECT name, unit_price_k::bigint AS unit_price_k, quantity::int AS quantity
        FROM order_items WHERE business_id = ${businessId}::uuid
      `),
    );
    expect([...lines]).toEqual([{ name: 'wig', unit_price_k: '150000', quantity: 2 }]);

    /* The announcement went out with the fact. */
    const announced = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: string }>(sql`
        SELECT COUNT(*) AS n FROM outbox_events
        WHERE business_id = ${businessId}::uuid AND type = 'order.placed'
      `),
    );
    expect([...announced][0]!.n).toBe('1');

    /* And the cart landed on the CUSTOMER's thread as a fact, priceless. */
    const recorded = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: string }>(sql`
        SELECT COUNT(*) AS n FROM conversation_messages
        WHERE business_id = ${businessId}::uuid AND body = '[order message]'
      `),
    );
    expect([...recorded][0]!.n).toBe('1');
  });

  /**
   * The door pays what the other doors pay.
   *
   * A cart arriving through WhatsApp becomes the same order and the same
   * invoice a storefront cart becomes, and until now it was the only one of
   * the three that cost the merchant nothing. A merchant on Integrate was
   * metered when the order came through their shop and free when the
   * identical order came through WhatsApp, which made the allowance a
   * number on the pricing page rather than a boundary in the code.
   */
  it('consumes an order unit and a document unit, as the other doors do', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002261', 'PN-METER-1');
    const period = usagePeriod(new Date());

    await post(
      orderPayload('2349097776111', 'wamid.METER.1', 'PN-METER-1', [
        { retailerId: wigId, quantity: 1 },
      ]),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect([...(await ordersOf(businessId))]).toHaveLength(1);
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, period),
    );
    expect(rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used).toBe(1);
    expect(rows.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used).toBe(1);
  });

  /* Owner decision on #271: a terminal refusal whose refund fails is not
   * processed; the retry gives back what the first attempt paid, once. */
  it('retries a terminal refusal whose refund failed, and refunds exactly once', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002267', 'PN-METER-7');
    const period = usagePeriod(new Date());
    await post(
      orderPayload('2349097776777', 'wamid.METER.7', 'PN-METER-7', [
        { retailerId: wigId, quantity: 1 },
      ]),
    );
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      /* Integrate lapses the moment the document unit is paid, so the order
       * is refused after the meter; the first orders refund fails. */
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g60_wa_lapse() RETURNS trigger SECURITY DEFINER AS $$
        BEGIN UPDATE businesses SET plan = 'chat' WHERE id = NEW.business_id; RETURN NEW; END
        $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g60_wa_lapse AFTER INSERT OR UPDATE ON usage_counters
          FOR EACH ROW WHEN (NEW.unit = 'DOCUMENT_GENERATION' AND NEW.used > 0)
          EXECUTE FUNCTION g60_wa_lapse()`);
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g60_wa_refund_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g60_wa_refund_fails() RETURNS trigger SECURITY DEFINER AS $$
        BEGIN
          IF NEW.unit = 'CATALOGUE_ORDERS' AND NEW.used < OLD.used
             AND nextval('g60_wa_refund_once') = 1 THEN
            RAISE EXCEPTION 'g60: the refund is unavailable';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g60_wa_refund_fails BEFORE UPDATE ON usage_counters
          FOR EACH ROW EXECUTE FUNCTION g60_wa_refund_fails()`);

      expect(await runUntilFailed(businessId, 'refund')).toBe(1);
      await ownerDb.execute(sql`
        UPDATE jobs SET run_at = now() WHERE business_id = ${businessId}::uuid AND state <> 'done'`);
      const runner = buildRunner(workerDb, db, deps);
      while (await runner.runOnce()) {
        /* the retry, and anything else due */
      }
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g60_wa_lapse ON usage_counters`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g60_wa_lapse()`);
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g60_wa_refund_fails ON usage_counters`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g60_wa_refund_fails()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g60_wa_refund_once`);
      await close();
    }
    expect([...(await ordersOf(businessId))]).toHaveLength(0);
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, period),
    );
    expect(rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used ?? 0).toBe(0);
    expect(rows.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used ?? 0).toBe(0);
  });

  /* Final review of #271: the order unit is taken, then the document meter
   * fails; the order unit goes back before the job retries. */
  it('gives the order unit back when the document meter fails', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002268', 'PN-METER-8');
    const period = usagePeriod(new Date());
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    /* Posted first: the webhook itself writes a usage row. */
    await post(
      orderPayload('2349097776888', 'wamid.METER.8', 'PN-METER-8', [
        { retailerId: wigId, quantity: 1 },
      ]),
    );
    try {
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g60_doc_meter_fails() RETURNS trigger AS $$
        BEGIN
          IF NEW.unit = 'DOCUMENT_GENERATION' THEN RAISE EXCEPTION 'g60: the meter is unavailable'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g60_doc_meter_fails BEFORE INSERT OR UPDATE ON usage_counters
          FOR EACH ROW EXECUTE FUNCTION g60_doc_meter_fails()`);
      expect(await runUntilFailed(businessId, 'the meter is unavailable')).toBe(1);
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g60_doc_meter_fails ON usage_counters`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g60_doc_meter_fails()`);
      await close();
    }
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, period),
    );
    expect(rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used ?? 0).toBe(0);
  });

  /* Final review of #271: the vault fails resolving the customer's phone on
   * the WhatsApp order door; the attempt books nothing and keeps nothing. */
  it('gives back both units when the vault fails resolving the buyer', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002269', 'PN-METER-9');
    const period = usagePeriod(new Date());
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g60_buyer_fails() RETURNS trigger AS $$
        BEGIN
          IF NEW.facet = 'phone' THEN RAISE EXCEPTION 'g60: the vault is unavailable'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g60_buyer_fails BEFORE INSERT ON customer_identities
          FOR EACH ROW EXECUTE FUNCTION g60_buyer_fails()`);
      await post(
        orderPayload('2349097776999', 'wamid.METER.9', 'PN-METER-9', [
          { retailerId: wigId, quantity: 1 },
        ]),
      );
      expect(await runUntilFailed(businessId, 'the vault is unavailable')).toBe(1);
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g60_buyer_fails ON customer_identities`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g60_buyer_fails()`);
      await close();
    }
    expect([...(await ordersOf(businessId))]).toHaveLength(0);
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, period),
    );
    expect(rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used ?? 0).toBe(0);
    expect(rows.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used ?? 0).toBe(0);
  });

  /* Codex on #271: an attempt dies holding both units (the buyer's vault
   * write and every refund fail); before the retry the merchant unlists the
   * item. The retry refuses the cart, and gives back what the event held. */
  it('gives back carried units when a retry refuses a cart that changed', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002270', 'PN-METER-10');
    const period = usagePeriod(new Date());
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g60_cart_buyer_fails() RETURNS trigger AS $$
        BEGIN
          IF NEW.facet = 'phone' THEN RAISE EXCEPTION 'g60: the vault is unavailable'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g60_cart_buyer_fails BEFORE INSERT ON customer_identities
          FOR EACH ROW EXECUTE FUNCTION g60_cart_buyer_fails()`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g60_cart_refund_fails() RETURNS trigger AS $$
        BEGIN
          IF NEW.used < OLD.used THEN RAISE EXCEPTION 'g60: the refund is unavailable'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g60_cart_refund_fails BEFORE UPDATE ON usage_counters
          FOR EACH ROW EXECUTE FUNCTION g60_cart_refund_fails()`);
      await post(
        orderPayload('2349097777010', 'wamid.METER.10', 'PN-METER-10', [
          { retailerId: wigId, quantity: 1 },
        ]),
      );
      expect(await runUntilFailed(businessId, 'the vault is unavailable')).toBe(1);
    } finally {
      await ownerDb.execute(
        sql`DROP TRIGGER IF EXISTS g60_cart_buyer_fails ON customer_identities`,
      );
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g60_cart_buyer_fails()`);
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g60_cart_refund_fails ON usage_counters`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g60_cart_refund_fails()`);
    }
    try {
      /* Both units are still held by the event the retry will run. */
      const held = await withBusiness(db, businessId, (tx) =>
        usageRepo.usageFor(tx, businessId, period),
      );
      expect(held.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used).toBe(1);
      expect(held.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used).toBe(1);
      await ownerDb.execute(sql`UPDATE products SET active = 0 WHERE id = ${wigId}::uuid`);
      await ownerDb.execute(sql`
        UPDATE jobs SET run_at = now() WHERE business_id = ${businessId}::uuid AND state <> 'done'`);
      const runner = buildRunner(workerDb, db, deps);
      while (await runner.runOnce()) {
        /* the retry, and anything else due */
      }
    } finally {
      await close();
    }
    expect([...(await ordersOf(businessId))]).toHaveLength(0);
    expect(await invoiceCount(businessId)).toBe(0);
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, period),
    );
    expect(rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used ?? 0).toBe(0);
    expect(rows.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used ?? 0).toBe(0);
  });

  /* Codex on #271: a reclaimed attempt runs beside the first, which has
   * placed and validated the order but not yet committed. The second's
   * PlaceOrder is a replay of the first: the order stands, so its units stay
   * paid, once each. */
  it('keeps the units of an order a reclaimed attempt finds already placed', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002272', 'PN-METER-12');
    const period = usagePeriod(new Date());
    /* A returning buyer: their thread already exists, so nothing else
     * serialises the two attempts before the order. */
    await post(
      orderPayload('2349097777012', 'wamid.METER.12a', 'PN-METER-12', [
        { retailerId: wigId, quantity: 1 },
      ]),
    );
    const drain = buildRunner(workerDb, db, deps);
    while (await drain.runOnce()) {
      /* the first order and everything it queued */
    }
    /* A different cart, so it is not refused as a repeat of the first. */
    const bag = await withBusiness(db, businessId, (tx) =>
      catalogueRepo.createProduct(tx, businessId, { name: 'bag', unitPriceK: 50_000 }),
    );
    await post(
      orderPayload('2349097777012', 'wamid.METER.12', 'PN-METER-12', [
        { retailerId: bag.id, quantity: 1 },
      ]),
    );
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      /* The first attempt stalls once, after its invoice, before it commits. */
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g60_replay_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g60_invoice_stalls() RETURNS trigger SECURITY DEFINER AS $$
        BEGIN
          IF nextval('g60_replay_once') = 1 THEN PERFORM pg_sleep(2); END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g60_invoice_stalls AFTER INSERT ON invoices
          FOR EACH ROW EXECUTE FUNCTION g60_invoice_stalls()`);

      const first = buildRunner(workerDb, db, deps).runOnce();
      await new Promise((r) => setTimeout(r, 700));
      /* What `reclaimStalled` does to a job whose worker went quiet. */
      await ownerDb.execute(sql`
        UPDATE jobs SET state = 'pending', locked_at = NULL, locked_by = NULL
         WHERE business_id = ${businessId}::uuid AND state = 'running'`);
      const second = buildRunner(workerDb, db, deps).runOnce();
      await Promise.allSettled([first, second]);
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g60_invoice_stalls ON invoices`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g60_invoice_stalls()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g60_replay_once`);
      await close();
    }
    expect([...(await ordersOf(businessId))]).toHaveLength(2);
    expect(await invoiceCount(businessId)).toBe(2);
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, period),
    );
    expect(rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used).toBe(2);
    expect(rows.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used).toBe(2);
  });

  /* Idempotency and metering have to agree: Meta redelivers, and a second
   * delivery that places no second order must not charge for one either. */
  it('charges nothing twice for a redelivered webhook', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002262', 'PN-METER-2');
    const period = usagePeriod(new Date());
    const payload = orderPayload('2349097776222', 'wamid.METER.2', 'PN-METER-2', [
      { retailerId: wigId, quantity: 1 },
    ]);

    await post(payload);
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    await post(payload);
    await buildRunner(workerDb, db, deps).runOnce();

    expect([...(await ordersOf(businessId))]).toHaveLength(1);
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, period),
    );
    expect(rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used).toBe(1);
    expect(rows.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used).toBe(1);
  });

  /**
   * A used-up allowance stops the order rather than taking it for free.
   *
   * The counter is spent through the same door the confirmation spends it,
   * so the refusal below is the real one rather than a simulated state.
   */
  it('takes no order once the orders allowance is used up, and charges nothing', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002263', 'PN-METER-3');
    const period = usagePeriod(new Date());
    const orderAllowance = allowanceFor('trial', 'CATALOGUE_ORDERS');
    for (let taken = 0; taken < orderAllowance; taken += 1) {
      expect(
        await withBusiness(db, businessId, (tx) =>
          usageRepo.consumeUnit(tx, businessId, period, 'CATALOGUE_ORDERS', orderAllowance),
        ),
      ).toBe(true);
    }

    await post(
      orderPayload('2349097776333', 'wamid.METER.3', 'PN-METER-3', [
        { retailerId: wigId, quantity: 1 },
      ]),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* No order, no invoice, and the document unit was never taken: the
     * refusal happens before anything is reserved beyond the order unit
     * the counter itself refused. */
    expect([...(await ordersOf(businessId))]).toHaveLength(0);
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, period),
    );
    expect(rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used).toBe(orderAllowance);
    expect(rows.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used ?? 0).toBe(0);
  });

  /**
   * A plan that does not sell takes nothing at all.
   *
   * Chat carries no `REKODA_INTEGRATE`, and the gate answers before the
   * meter so the merchant is not charged for discovering that their plan
   * cannot capture orders.
   */
  it('takes no order and charges nothing on a plan without Integrate', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002264', 'PN-METER-4');
    await setPlanForTest(db, {
      businessId,
      plan: 'chat',
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      actor: 'operator:test',
    });
    const period = usagePeriod(new Date());

    await post(
      orderPayload('2349097776444', 'wamid.METER.4', 'PN-METER-4', [
        { retailerId: wigId, quantity: 1 },
      ]),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect([...(await ordersOf(businessId))]).toHaveLength(0);
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, period),
    );
    expect(rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used ?? 0).toBe(0);
    expect(rows.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used ?? 0).toBe(0);
  });

  /* A cart the shelf cannot serve is refused before the meter, so a
   * customer naming something that does not exist cannot spend the
   * merchant's allowance. */
  it('charges nothing for a cart naming an item the shelf does not sell', async () => {
    const { businessId } = await seedCommerceMerchant('+2348030002265', 'PN-METER-5');
    const period = usagePeriod(new Date());

    await post(
      orderPayload('2349097776555', 'wamid.METER.5', 'PN-METER-5', [
        { retailerId: 'not-a-product-of-this-shop', quantity: 1 },
      ]),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect([...(await ordersOf(businessId))]).toHaveLength(0);
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, period),
    );
    expect(rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used ?? 0).toBe(0);
    expect(rows.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used ?? 0).toBe(0);
  });

  it('a redelivered webhook places nothing twice', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002222', 'PN-CART-2');
    const payload = orderPayload('2349097772222', 'wamid.CART.2', 'PN-CART-2', [
      { retailerId: wigId, quantity: 1 },
    ]);

    await post(payload);
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    await post(payload);
    await buildRunner(workerDb, db, deps).runOnce();

    expect([...(await ordersOf(businessId))]).toHaveLength(1);
  });
});
