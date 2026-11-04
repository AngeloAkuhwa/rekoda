/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: counting stock. Split by concern from meta.integration.test.ts; the shared
 * app, stubs and payload helpers are in meta-webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { identity, usageRepo, stockRepo, withBusiness, sql } from '@rekoda/db';
import { replies, usagePeriod } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
import {
  db,
  deps,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';

useMetaWebhookHarness();

/**
 * Stock that actually moves.
 *
 * `products` and `inventory_movements` have existed since migration 0000 and
 * nothing ever wrote to either, while `AdjustInventory` sat in the command
 * contract since M0 with no handler. A merchant who typed "add 20 bags of
 * rice" was told that recording that kind of entry was not built yet.
 *
 * On-hand is SUM(delta) over an append-only ledger, so every assertion below
 * is about a figure nothing stores.
 */
describe('counting stock', () => {
  const adjust = (mention: string, delta: number) => ({
    intent: 'AdjustInventory',
    productMention: mention,
    quantityDelta: delta,
  });

  async function seedMerchant(phone: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  async function say(wamid: string, command: Record<string, unknown>, text: string) {
    stubTransport.replyWith(command);
    await post(messagePayload('2348031234567', wamid, text));
    await drain();
  }

  async function plain(wamid: string, text: string) {
    await post(messagePayload('2348031234567', wamid, text));
    await drain();
  }

  const onHand = (businessId: string, name: string) =>
    withBusiness(db, businessId, (tx) => stockRepo.productByName(tx, businessId, name));

  it('previews a count before saving it, like every other write', async () => {
    const business = await seedMerchant('+2348031234567');

    await say('wamid.S1', adjust('bags of rice', 20), 'add 20 bags of rice');

    expect(stubSender.lastText).toContain('Adding 20 bags of rice');
    expect(stubSender.lastText).toContain('Was: 0');
    expect(stubSender.lastText).toContain('Now: 20');
    /* Nothing written until the yes. The product does not exist yet either. */
    expect(await onHand(business.id, 'bags of rice')).toBeNull();
  });

  it('saves the count on yes and says what is left', async () => {
    const business = await seedMerchant('+2348031234567');

    await say('wamid.S2', adjust('bags of rice', 20), 'add 20 bags of rice');
    await plain('wamid.S3', 'yes');

    expect(stubSender.lastText).toContain('Added 20 bags of rice');
    expect(stubSender.lastText).toContain('You now have 20');
    expect((await onHand(business.id, 'bags of rice'))?.onHand).toBe(20);
  });

  /**
   * The destructive half, on the DEFAULT configuration (PR-027, Appendix
   * D.2): a preview that shows stock DISAPPEARING opens a pending
   * confirmation recording the exact consequence, and the yes claims it
   * through the command bus. The addition before it opens nothing, because
   * adding stock is STANDARD.
   *
   * This used to run under `commandAdjustInventory: true`, and that was the
   * defect it hid. The flag then defaulted OFF, and with it off the write-off fell
   * to a bare `adjustInventoryWork` call: stock disappeared from a chat
   * message with no confirmation claimed and none ever opened. The flag now
   * governs the ADDITIVE path only; `destructive` crosses the bus whatever it
   * says, so this suite uses the deps a real deployment runs.
   */
  it('a write-off opens a confirmation the yes then claims, with no flag on', async () => {
    const business = await seedMerchant('+2348031234567');

    await say('wamid.SD1', adjust('bags of rice', 20), 'add 20 bags of rice');
    await plain('wamid.SD2', 'yes');
    /* Adding stock opened NO confirmation: STANDARD stays cheap. */
    const afterAdd = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM pending_confirmations
            WHERE business_id = ${business.id}::uuid`,
      ),
    );
    expect(Number([...afterAdd][0]?.n)).toBe(0);

    await say('wamid.SD3', adjust('bags of rice', -15), '15 bags got water damage');
    expect(stubSender.lastText).toContain('Removing 15 bags of rice');
    await plain('wamid.SD4', 'yes');

    expect(stubSender.lastText).toContain('Removed 15 bags of rice');
    expect((await onHand(business.id, 'bags of rice'))?.onHand).toBe(5);

    /* The confirmation exists, was CLAIMED by the yes, and recorded the
     * consequence the merchant read. */
    const confirmations = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ command: string; consequence: string; claimed_at: Date | null }>(
        sql`SELECT command, consequence, claimed_at FROM pending_confirmations
            WHERE business_id = ${business.id}::uuid`,
      ),
    );
    const row = [...confirmations][0];
    expect([...confirmations]).toHaveLength(1);
    expect(row?.command).toBe('AdjustInventory');
    expect(row?.consequence).toContain('Removing 15 bags of rice');
    expect(row?.claimed_at).not.toBeNull();
  });

  it('a write-off still crosses the bus and its confirmation when the flag is 0 (Build 9)', async () => {
    const config = deps.config as unknown as { commandAdjustInventory: boolean };
    const was = config.commandAdjustInventory;
    config.commandAdjustInventory = false;
    try {
      const business = await seedMerchant('+2348031234567');
      await say('wamid.SD0-1', adjust('bags of rice', 20), 'add 20 bags of rice');
      await plain('wamid.SD0-2', 'yes');
      await say('wamid.SD0-3', adjust('bags of rice', -15), '15 bags got water damage');
      await plain('wamid.SD0-4', 'yes');
      expect((await onHand(business.id, 'bags of rice'))?.onHand).toBe(5);
      /* HIGH_RISK: the confirmation was opened and claimed through the bus,
       * whatever the rollout flag said. */
      const claimed = await withBusiness(db, business.id, (tx) =>
        tx.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM pending_confirmations
              WHERE business_id = ${business.id}::uuid AND command = 'AdjustInventory'
                AND claimed_at IS NOT NULL`,
        ),
      );
      expect(Number([...claimed][0]?.n)).toBe(1);
    } finally {
      config.commandAdjustInventory = was;
    }
  });

  it('adds onto a count that is already there', async () => {
    const business = await seedMerchant('+2348031234567');

    await say('wamid.S4', adjust('bags of rice', 20), 'add 20 bags of rice');
    await plain('wamid.S5', 'yes');
    await say('wamid.S6', adjust('bags of rice', 5), 'add 5 more bags of rice');

    expect(stubSender.lastText).toContain('Was: 20');
    expect(stubSender.lastText).toContain('Now: 25');

    await plain('wamid.S7', 'yes');
    expect((await onHand(business.id, 'bags of rice'))?.onHand).toBe(25);
  });

  it('refuses to take a shop below zero, and writes nothing', async () => {
    const business = await seedMerchant('+2348031234567');

    await say('wamid.S8', adjust('bags of rice', 4), 'add 4 bags of rice');
    await plain('wamid.S9', 'yes');
    await say('wamid.S10', adjust('bags of rice', -9), 'remove 9 bags of rice');

    expect(stubSender.lastText).toContain('less than none');
    /* A question, not a preview: there is no yes to give, so nothing moved. */
    expect(stubSender.lastText).not.toContain('Reply *yes*');
    expect((await onHand(business.id, 'bags of rice'))?.onHand).toBe(4);
  });

  it('answers what is left without a model call', async () => {
    const business = await seedMerchant('+2348031234567');
    await say('wamid.S11', adjust('bags of rice', 40), 'add 40 bags of rice');
    await plain('wamid.S12', 'yes');
    await say('wamid.S13', adjust('wigs', 2), 'add 2 wigs');
    await plain('wamid.S14', 'yes');

    const before = stubTransport.requests.length;
    await plain('wamid.S15', 'stock');

    /* Free, because a merchant checks stock several times a day and charging
     * a model call to answer a SELECT would be charging them for nothing. */
    expect(stubTransport.requests.length).toBe(before);
    expect(stubSender.lastText).toContain('wigs: 2');
    expect(stubSender.lastText).toContain('bags of rice: 40');
    /* Lowest first: the row that needs them is the one about to run out. */
    expect(stubSender.lastText!.indexOf('wigs')).toBeLessThan(
      stubSender.lastText!.indexOf('bags of rice'),
    );
    expect(business.id).toBeTruthy();
  });

  it('says so plainly when nothing is counted yet', async () => {
    await seedMerchant('+2348031234567');
    await plain('wamid.S16', 'stock');
    expect(stubSender.lastText).toContain('not counting any stock yet');
  });

  /**
   * The reply used to hand a merchant twenty rows and let them read it as
   * their whole shop.
   *
   * A shop with forty five products got twenty of them, no count, and no
   * line saying so. The merchant's reading is that twenty five products
   * stopped being counted, and nothing in the message contradicts it.
   */
  it('says how many products the list left out', async () => {
    const business = await seedMerchant('+2348031234567');
    await withBusiness(db, business.id, async (tx) => {
      for (let i = 0; i < 45; i += 1) {
        const product = await stockRepo.findOrCreateProduct(tx, business.id, `Product ${i + 1}`);
        await stockRepo.recordMovement(tx, {
          businessId: business.id,
          productId: product.id,
          delta: i + 1,
          reason: 'adjustment',
          sourceType: 'chat',
          sourceId: 'seed',
        });
      }
    });

    await plain('wamid.S17', 'stock');

    const text = stubSender.lastText!;
    expect(text).toMatch(/\.\.\.and \d+ more on your dashboard\./);
    /* And the number is the truth: what the shop holds less what fitted. */
    const shown = text.split('\n').filter((l) => /^Product \d+: /.test(l)).length;
    expect(text).toContain(`...and ${45 - shown} more on your dashboard.`);
    // Still a message a merchant reads rather than one WhatsApp folds away.
    expect(text.length).toBeLessThanOrEqual(replies.MAX_REPLY_CHARS);
  });

  it('takes stock off the shelf when a sale is confirmed', async () => {
    const business = await seedMerchant('+2348031234567');
    await say('wamid.S17', adjust('wig', 10), 'add 10 wigs');
    await plain('wamid.S18', 'yes');

    await say(
      'wamid.S19',
      {
        intent: 'RecordSale',
        customer: { kind: 'none' },
        items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
        statedTotal: 150_000,
        reportedPayment: 0,
        paymentMethod: 'transfer',
        discount: 0,
        deliveryFee: 0,
        dueDescription: null,
      },
      'sold 3 wigs for 150k',
    );
    await plain('wamid.S20', 'yes');

    expect((await onHand(business.id, 'wig'))?.onHand).toBe(7);
  });

  it('does not invent a product for a sale of something never counted', async () => {
    const business = await seedMerchant('+2348031234567');

    await say(
      'wamid.S21',
      {
        intent: 'RecordSale',
        customer: { kind: 'none' },
        items: [{ name: 'generator', quantity: 1, unitPrice: 200_000 }],
        statedTotal: 200_000,
        reportedPayment: 0,
        paymentMethod: 'transfer',
        discount: 0,
        deliveryFee: 0,
        dueDescription: null,
      },
      'sold a generator for 200k',
    );
    await plain('wamid.S22', 'yes');

    /* Otherwise a shop that sold one of something it never stocked would be
     * told it holds minus one, forever. */
    expect(await onHand(business.id, 'generator')).toBeNull();
  });

  it('costs no document unit, because a count produces no paper', async () => {
    const business = await seedMerchant('+2348031234567');
    await say('wamid.S23', adjust('bags of rice', 20), 'add 20 bags of rice');
    await plain('wamid.S24', 'yes');

    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, usagePeriod(new Date())),
    );
    const documents = rows.find((r) => r.unit === 'DOCUMENT_GENERATION');
    expect(documents?.used ?? 0).toBe(0);
  });
});
