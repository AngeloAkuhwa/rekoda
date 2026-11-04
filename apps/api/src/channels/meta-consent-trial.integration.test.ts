/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: consent and erasure, the trial clock and metering. Split by concern from
 * meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  conversationsRepo,
  identity,
  jobsRepo,
  quotaRepo,
  usageRepo,
  withBusiness,
  sql,
} from '@rekoda/db';
import { replies, usagePeriod } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
import { billingRepo, customersRepo, issueRepo } from '@rekoda/db';
import {
  db,
  deps,
  invoiceCount,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';

useMetaWebhookHarness();

describe('consent (STOP/START) and erasure, as facts not sentences', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  it('STOP persists, suppresses proactive deliveries, and START undoes it', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');

    await post(messagePayload('2348031234567', 'wamid.STOP1', 'stop'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.lastText).toContain('I will not message you again');
    expect(await identity.optedOutAt(db, '+2348031234567')).not.toBeNull();

    // A receipt delivery — the proactive send class — goes nowhere now.
    await deps.storage.put('test/suppressed-1', Buffer.from('%PDF-fake'), 'application/pdf');
    const doc = await withBusiness(db, business.id, (tx) =>
      issueRepo.recordDocument(tx, {
        businessId: business.id,
        kind: 'receipt_pdf',
        storageKey: 'test/suppressed-1',
        refNumber: 'RCT-2026-000009',
        bytes: 9,
      }),
    );
    await withBusiness(db, business.id, (tx) =>
      jobsRepo.enqueue(tx, {
        businessId: business.id,
        kind: 'document.deliver',
        payload: { documentId: doc.id },
        singletonKey: `deliver:${doc.id}`,
      }),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.documents).toHaveLength(0);

    // START clears the flag; the same delivery class flows again.
    await post(messagePayload('2348031234567', 'wamid.START1', 'start'));
    const runner = buildRunner(workerDb, db, deps);
    expect(await runner.runOnce()).toBe(true);
    expect(await identity.optedOutAt(db, '+2348031234567')).toBeNull();
  });

  it.each(['abeg stop', 'no send me again', 'stop o'])(
    'a natural %j persists, suppresses proactive deliveries, and START undoes it (G-80)',
    async (text) => {
      const business = await seedMerchant('+2348031234567', 'Ada Fashion');

      await post(messagePayload('2348031234567', 'wamid.G80-STOP1', text));
      expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
      expect(stubSender.lastText).toBe(replies.optedOut().text);
      expect(await identity.optedOutAt(db, '+2348031234567')).not.toBeNull();
      expect(stubTransport.requests).toHaveLength(0);

      // A receipt delivery, the proactive send class, goes nowhere now.
      await deps.storage.put('test/g80-suppressed', Buffer.from('%PDF-fake'), 'application/pdf');
      const doc = await withBusiness(db, business.id, (tx) =>
        issueRepo.recordDocument(tx, {
          businessId: business.id,
          kind: 'receipt_pdf',
          storageKey: 'test/g80-suppressed',
          refNumber: 'RCT-2026-000010',
          bytes: 9,
        }),
      );
      await withBusiness(db, business.id, (tx) =>
        jobsRepo.enqueue(tx, {
          businessId: business.id,
          kind: 'document.deliver',
          payload: { documentId: doc.id },
          singletonKey: `deliver:${doc.id}`,
        }),
      );
      expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
      expect(stubSender.documents).toHaveLength(0);

      // Saying it again changes nothing and still answers the same way.
      await post(messagePayload('2348031234567', 'wamid.G80-STOP2', text));
      expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
      expect(stubSender.lastText).toBe(replies.optedOut().text);
      expect(await identity.optedOutAt(db, '+2348031234567')).not.toBeNull();

      // START undoes it ("abeg start" does not; see the G-80 START test).
      await post(messagePayload('2348031234567', 'wamid.G80-START', 'START'));
      expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
      expect(await identity.optedOutAt(db, '+2348031234567')).toBeNull();
    },
  );

  it('an explicit resend still delivers to an opted-out merchant — they asked', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await identity.setOptOut(db, '+2348031234567', new Date());

    await deps.storage.put('test/resend-1', Buffer.from('%PDF-fake'), 'application/pdf');
    await withBusiness(db, business.id, (tx) =>
      issueRepo.recordDocument(tx, {
        businessId: business.id,
        kind: 'invoice_pdf',
        storageKey: 'test/resend-1',
        refNumber: 'INV-2026-000011',
        bytes: 9,
      }),
    );

    await post(messagePayload('2348031234567', 'wamid.RESENDOPT', 'resend'));
    const runner = buildRunner(workerDb, db, deps);
    expect(await runner.runOnce()).toBe(true); // the inbound command
    expect(await runner.runOnce()).toBe(true); // the delivery it queued
    expect(stubSender.documents).toHaveLength(1);
    expect(stubSender.lastDocument?.filename).toBe('INV-2026-000011.pdf');
  });

  it('erasure takes two exact asks, deletes every identity facet, and says how many', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T1',
      [
        { facet: 'name', ciphertext: 'sealed-name', matchKey: 'mk-name' },
        { facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-phone' },
      ],
    );

    await post(messagePayload('2348031234567', 'wamid.DEL1', 'delete my data'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');

    await post(messagePayload('2348031234567', 'wamid.DEL2', 'delete my data'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.lastText).toContain('deleted (2 records)');
    /* The rest is on the deployment's own data deletion page: REKODA_WEB_URL,
     * through config.webUrl, the only link and the last thing in the reply. */
    expect((stubSender.lastText ?? '').match(/\S+:\/\/\S+/g)).toEqual([
      'https://books.example.test/data-deletion',
    ]);
    expect(stubSender.lastText).toMatch(/\nhttps:\/\/books\.example\.test\/data-deletion$/);
    // No bare domain beside the link either.
    expect(
      (stubSender.lastText ?? '').replace('https://books.example.test/data-deletion', ''),
    ).not.toMatch(/www\.|[a-z0-9-]\.[a-z]{2,}/i);

    const left = await withBusiness(db, business.id, (tx) =>
      customersRepo.identityFacetsFor(tx, business.id, customer.id),
    );
    expect(left).toEqual([]);
  });

  it('erasure with no web URL still deletes, and names no link at all', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T2',
      [{ facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-phone-2' }],
    );
    const noWeb = { ...deps, config: { ...deps.config, webUrl: null } };

    await post(messagePayload('2348031234567', 'wamid.DELN1', 'delete my data'));
    expect(await buildRunner(workerDb, db, noWeb).runOnce()).toBe(true);
    await post(messagePayload('2348031234567', 'wamid.DELN2', 'delete my data'));
    expect(await buildRunner(workerDb, db, noWeb).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('deleted (1 record)');
    expect(stubSender.lastText).toContain('Your conversations and account can be deleted too');
    // No scheme, no www, and no bare `name.tld` a phone would still link.
    expect(stubSender.lastText).not.toMatch(/:\/\/|www\.|[a-z0-9-]\.[a-z]{2,}/i);
    const left = await withBusiness(db, business.id, (tx) =>
      customersRepo.identityFacetsFor(tx, business.id, customer.id),
    );
    expect(left).toEqual([]);
  });

  /**
   * The same two asks with the EraseData flag ON (PR-027): identical
   * deletion, and the Appendix D machinery underneath — the first ask opened
   * a pending confirmation recording the consequence, the second claimed it
   * through the command bus.
   */
  it('erasure opens a confirmation the second ask claims, with no flag to turn it off', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await customersRepo.createCustomerWithIdentities(db, business.id, 'CUSTOMER_T9', [
      { facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-phone-9' },
    ]);
    /* No flag. EraseData is HIGH_RISK, so the confirmation record is part of
     * the command and not of a rollout: this runs the default deps every
     * deployment uses. */
    await post(messagePayload('2348031234567', 'wamid.DELF1', 'delete my data'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');

    await post(messagePayload('2348031234567', 'wamid.DELF2', 'delete my data'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.lastText).toContain('deleted (1 record)');

    const confirmations = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ command: string; claimed_at: Date | null }>(
        sql`SELECT command, claimed_at FROM pending_confirmations
            WHERE business_id = ${business.id}::uuid`,
      ),
    );
    expect([...confirmations]).toHaveLength(1);
    expect([...confirmations][0]?.command).toBe('EraseData');
    expect([...confirmations][0]?.claimed_at).not.toBeNull();
  });

  /**
   * Owner only. This deletes every customer's contact details for the whole
   * business in one irreversible statement, which is not a thing an
   * accountant or a delegate should be able to do from a phone.
   */
  it('refuses erasure from a member who is not the owner', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    const accountant = await identity.upsertUserByPhone(db, '+2348039990001');
    await identity.addMembership(db, business.id, accountant.id, 'accountant');
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T9',
      [{ facet: 'name', ciphertext: 'sealed-name', matchKey: 'mk-name-9' }],
    );

    await post(messagePayload('2348039990001', 'wamid.DELX', 'delete my data'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('Only the business owner can delete');
    const left = await withBusiness(db, business.id, (tx) =>
      customersRepo.identityFacetsFor(tx, business.id, customer.id),
    );
    expect(left).toHaveLength(1);
  });

  /**
   * Asking to erase clears whatever was waiting for a yes, and the merchant
   * has to be told: a sale they previewed a minute ago silently vanishing is
   * how a shop ends up with a day's takings unrecorded.
   */
  it('says so when the erasure ask discards an entry waiting for a yes', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');

    stubTransport.replyWith({
      intent: 'RecordSale',
      customer: { kind: 'token', token: 'CUSTOMER_7K2' },
      items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
      statedTotal: 150_000,
      reportedPayment: 0,
      paymentMethod: 'transfer',
      discount: null,
      deliveryFee: null,
      dueDescription: null,
    });
    await post(messagePayload('2348031234567', 'wamid.DELD1', 'Ada bought 3 wigs for 150k'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.lastText).toContain('Reply *yes*');

    await post(messagePayload('2348031234567', 'wamid.DELD2', 'delete my data'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('waiting for your yes has been dropped');
  });

  it('a "yes" after the erasure prompt keeps everything — only the phrase confirms', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T2',
      [{ facet: 'name', ciphertext: 'sealed', matchKey: 'mk' }],
    );

    await post(messagePayload('2348031234567', 'wamid.DEL3', 'delete my data'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    await post(messagePayload('2348031234567', 'wamid.DELYES', 'yes'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('Kept');
    const left = await withBusiness(db, business.id, (tx) =>
      customersRepo.identityFacetsFor(tx, business.id, customer.id),
    );
    expect(left).toHaveLength(1);

    // And the claimed draft cannot be resurrected: a fresh ask starts over.
    await post(messagePayload('2348031234567', 'wamid.DEL4', 'delete my data'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');
  });
});

describe('the trial clock and the upgrade door', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  /** Age the trial past its date, as the full trial length would. */
  async function expireTrial(businessId: string) {
    await billingRepo.setPlan(db, {
      businessId,
      plan: 'trial',
      expiresAt: new Date(Date.now() - 1_000),
      actor: 'operator:test-clock',
    });
  }

  it('tells an expired trial the truth, and spends no model call doing it', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await expireTrial(business.id);

    await post(messagePayload('2348031234567', 'wamid.EXP1', 'Ada bought 3 wigs for 150k'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('free trial has ended');
    expect(stubSender.lastText).toContain('Reply *upgrade*');
    // The gate runs before the model: an expired trial costs nothing.
    expect(stubTransport.requests).toHaveLength(0);
  });

  it('still answers the free read commands after the trial ends', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await expireTrial(business.id);

    await post(messagePayload('2348031234567', 'wamid.EXP2', 'who owes me'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    // Reading is never gated — the books stay theirs.
    expect(stubSender.lastText).toContain('Nobody owes you right now');
  });

  it('records an upgrade request from chat and answers a human, not a dead link', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await expireTrial(business.id);

    await post(messagePayload('2348031234567', 'wamid.UPG1', 'upgrade'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('upgrade request');
    expect(stubSender.lastText).not.toContain('rekoda.app/pricing');

    const requests = await withBusiness(db, business.id, (tx) =>
      billingRepo.upgradeRequestsFor(tx, business.id),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.fromPlan).toBe('expired');
  });

  it('recording works again the moment an operator moves them onto a plan', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await expireTrial(business.id);

    await billingRepo.setPlan(db, {
      businessId: business.id,
      plan: 'chat',
      expiresAt: new Date(Date.now() + 31 * 86_400_000),
      actor: 'operator:test',
    });

    await post(messagePayload('2348031234567', 'wamid.AFTER', 'Ada bought 3 wigs for 150k'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    // Back to the ordinary path: the model ran and a preview came back.
    expect(stubTransport.requests).toHaveLength(1);
    expect(stubSender.lastText).not.toContain('trial has ended');
  });
});

describe('metering the things that cost money', () => {
  /** A sale the stub will hand back, so the confirm path is reached. */
  const A_SALE = {
    intent: 'RecordSale',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
    statedTotal: 150_000,
    reportedPayment: 100_000,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  };

  it('spends a documents unit per invoice, and refuses between transactions when they run out', async () => {
    const user = await identity.upsertUserByPhone(db, '+2348031234567');
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });

    // Burn the trial's 25 documents, leaving the allowance exactly spent.
    const period = usagePeriod(new Date());
    await withBusiness(db, business.id, (tx) =>
      usageRepo.consumeUnit(tx, business.id, period, 'DOCUMENT_GENERATION', 25, 25),
    );

    stubTransport.replyWith(A_SALE);
    await post(messagePayload('2348031234567', 'wamid.DOC1', 'Ada bought 3 wigs for 150k'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    // The preview still happens: the message unit paid for reading it.
    expect(stubSender.lastText).toContain('Reply *yes*');

    await post(messagePayload('2348031234567', 'wamid.DOC2', 'yes'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('invoices and receipts');
    expect(stubSender.lastText).toContain('Reply *upgrade*');
    // Nothing was booked: the refusal happened BEFORE the sale, so the
    // merchant lost neither the sale nor the draft.
    expect(await invoiceCount(business.id)).toBe(0);
  });

  it('records the Meta media cost when a document is delivered', async () => {
    const user = await identity.upsertUserByPhone(db, '+2348031234567');
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    /* Inside the 24-hour window the owner opened by writing (G-67). */
    await withBusiness(db, business.id, (tx) =>
      conversationsRepo.recordInbound(tx, {
        businessId: business.id,
        channel: 'meta',
        kind: 'text',
        body: 'hello',
        providerMessageId: 'wamid.cost-window-1',
      }),
    );

    await deps.storage.put('test/cost-1', Buffer.from('%PDF-fake'), 'application/pdf');
    const doc = await withBusiness(db, business.id, (tx) =>
      issueRepo.recordDocument(tx, {
        businessId: business.id,
        kind: 'invoice_pdf',
        storageKey: 'test/cost-1',
        refNumber: 'INV-2026-000021',
        bytes: 9,
      }),
    );
    await withBusiness(db, business.id, (tx) =>
      jobsRepo.enqueue(tx, {
        businessId: business.id,
        kind: 'document.deliver',
        payload: { documentId: doc.id },
        singletonKey: `deliver:${doc.id}`,
      }),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.documents).toHaveLength(1);

    /* Media is chargeable from 1 October 2026. The row has to exist NOW or
     * the repricing arrives with no baseline for the expensive class. */
    const totals = await withBusiness(db, business.id, (tx) => quotaRepo.usageTotals(tx, 'meta'));
    expect(totals.calls).toBeGreaterThanOrEqual(1);
  });
});
