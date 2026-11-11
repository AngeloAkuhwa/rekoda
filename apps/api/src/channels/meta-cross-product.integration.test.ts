/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: one customer across both products, and collecting money from chat. Split
 * by concern from meta.integration.test.ts; the shared app, stubs and payload helpers are in
 * meta-webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { identity, catalogueRepo, usageRepo, wabaRepo, withBusiness, sql } from '@rekoda/db';
import { usagePeriod } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
import { customersRepo, issueRepo, paymentsHub } from '@rekoda/db';
import {
  encryptFacet,
  matchKeyFor,
  participantIndexFor,
  PARTICIPANT_INDEX_KEY_VERSION,
} from '@rekoda/core/vault';
import { type ApiConfig } from '../config.js';
import {
  db,
  deps,
  intentsProvider,
  messagePayload,
  orderPayload,
  post,
  stubSender,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';
import { setPlanForTest, requireUrls, settlementDb } from '@rekoda/db/testing';

useMetaWebhookHarness();

describe('one customer, both products (spec §5.3 X2; X1, PR-092)', () => {
  it('a Chat sale and a WABA order for the same phone land on ONE customer, one ledger, one AR', async () => {
    const user = await identity.upsertUserByPhone(db, '+2348030002250');
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    const businessId = business.id;
    const wigId = await withBusiness(db, businessId, async (tx) => {
      await wabaRepo.connectWaba(tx, {
        businessId,
        wabaId: 'waba-X2',
        phoneNumberId: 'PN-X2',
        accessTokenCipher: 'cipher-for-tests',
        tokenTail: '4821',
      });
      const wig = await catalogueRepo.createProduct(tx, businessId, {
        name: 'wig',
        unitPriceK: 150_000,
      });
      return wig.id;
    });

    /* Week one: Chat records a walk-in sale to Chidi, anchored on the
     * phone the privacy gateway folds every identity onto. */
    const chidi = await deps.gateway.resolveStorefrontCustomer(
      businessId,
      'Chidi',
      '+2349097776666',
    );
    await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: chidi!.customerId,
        customerToken: chidi!.token,
        items: [{ name: 'wig', quantity: 1, unitPriceK: 150_000 }],
        subtotalK: 150_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 150_000,
        paidK: 0,
        balanceDueK: 150_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-x2',
        actor: 'owner',
      }),
    );

    /* Week two: the SAME phone sends a cart on the merchant's WABA. */
    await post(
      orderPayload('2349097776666', 'wamid.X2.1', 'PN-X2', [{ retailerId: wigId, quantity: 2 }]),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* ONE customer record: neither product holds its own customer table,
     * and identity resolved through the gateway in both directions. */
    const customers = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: string; id: string }>(
        sql`SELECT COUNT(*) AS n, MIN(id::text) AS id FROM customers WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect([...customers][0]!.n).toBe('1');
    expect([...customers][0]!.id).toBe(chidi!.customerId);

    /* Both invoices hang off that one record — the Chat sale and the
     * validated WABA order. */
    const invoices = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ customer_id: string; source_type: string; balance_due_k: string }>(
        sql`SELECT customer_id, source_type, balance_due_k::bigint AS balance_due_k
            FROM invoices WHERE business_id = ${businessId}::uuid ORDER BY created_at`,
      ),
    );
    const rows = [...invoices];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.source_type).sort()).toEqual(['chat', 'waba_catalogue']);
    expect(rows.every((r) => r.customer_id === chidi!.customerId)).toBe(true);

    /* ONE ledger, ONE AR balance: the receivable is the sum of both,
     * in one account, not a figure per product. */
    const ar = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ k: string }>(sql`
        SELECT COALESCE(SUM(e.debit_k - e.credit_k), 0)::bigint AS k
        FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE e.business_id = ${businessId}::uuid AND a.system_role = 'ACCOUNTS_RECEIVABLE'
      `),
    );
    expect(Number([...ar][0]!.k)).toBe(150_000 + 300_000);
  });
});

describe('send payment details across products (spec §5.3 X1; PR-093)', () => {
  const OWNER = '+2348030002260';
  const CUSTOMER_PHONE = '+2349097775577';

  async function seedComplete(
    phoneNumberId: string,
    opts: { plan?: 'complete' | 'chat'; windowOpen?: boolean } = {},
  ) {
    const user = await identity.upsertUserByPhone(db, OWNER);
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    const businessId = business.id;
    await setPlanForTest(db, {
      businessId,
      plan: opts.plan ?? 'complete',
      expiresAt: null,
      actor: 'operator:test',
    });
    let connectionId = '';
    await withBusiness(db, businessId, async (tx) => {
      const connected = await wabaRepo.connectWaba(tx, {
        businessId,
        wabaId: `waba-${phoneNumberId}`,
        phoneNumberId,
        accessTokenCipher: encryptFacet(
          'EAAG-merchant-token',
          deps.config.connectionKey,
          `${businessId}:waba_token`,
        ),
        tokenTail: '4821',
      });
      if (connected.outcome === 'connected') connectionId = connected.id;
      const connection = await paymentsHub.upsertConnection(tx, {
        businessId,
        providerType: 'paystack',
        settlementAccountLast4: '4821',
      });
      await paymentsHub.setConnectionState(tx, connection.id, {
        status: 'active',
        externalSubaccountId: 'ACCT_live1',
      });
      /* Pack units are credited only by settlement (OD-37). */
      await withBusiness(settlementDb(), businessId, (s) =>
        usageRepo.creditBonus(s, businessId, usagePeriod(new Date()), 'SERVICE_MESSAGE', 5),
      );
    });

    /* Chidi: phone-anchored through the gateway, email on file for the
     * mint, and (usually) a service window their last message opened. */
    const chidi = await deps.gateway.resolveStorefrontCustomer(businessId, 'Chidi', CUSTOMER_PHONE);
    await customersRepo.addIdentityFacet(db, businessId, chidi!.customerId, {
      facet: 'email',
      ciphertext: encryptFacet('chidi@example.com', deps.config.vaultKey, `${businessId}:email`),
      matchKey: null,
    });
    if (opts.windowOpen !== false) {
      const blindIndex = participantIndexFor(deps.config.matchKey, {
        businessId,
        channelAccountId: phoneNumberId,
        keyVersion: PARTICIPANT_INDEX_KEY_VERSION,
        normalisedParticipant: CUSTOMER_PHONE,
      });
      await withBusiness(db, businessId, (tx) =>
        wabaRepo.touchServiceWindow(tx, {
          businessId,
          wabaConnectionId: connectionId,
          customerHash: blindIndex,
        }),
      );
    }

    await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: chidi!.customerId,
        customerToken: chidi!.token,
        items: [{ name: 'gown', quantity: 1, unitPriceK: 8_000_000 }],
        subtotalK: 8_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 8_000_000,
        paidK: 0,
        balanceDueK: 8_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-x1',
        actor: 'owner',
      }),
    );
    return businessId;
  }

  async function ask(wamid: string) {
    await post(messagePayload(OWNER.slice(1), wamid, 'send payment details'));
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    expect(worked).toBe(true);
    while (worked) worked = await runner.runOnce();
  }

  const intentCount = (businessId: string) =>
    withBusiness(db, businessId, (tx) =>
      tx
        .execute<{
          n: string;
        }>(sql`SELECT COUNT(*) AS n FROM payment_intents WHERE business_id = ${businessId}::uuid`)
        .then((rows) => Number([...rows][0]!.n)),
    );

  it('a Complete business delivers into the customer thread: one intent, said plainly to both sides', async () => {
    const businessId = await seedComplete('PN-X1-1');

    await ask('wamid.X1.1');

    /* The customer holds the details, in their own thread on the
     * merchant's number: the figure and the link, nothing else. */
    expect(stubSender.connectionTexts).toHaveLength(1);
    expect(stubSender.connectionTexts[0]).toMatchObject({
      to: CUSTOMER_PHONE,
      phoneNumberId: 'PN-X1-1',
      accessToken: 'EAAG-merchant-token',
    });
    expect(stubSender.connectionTexts[0]!.text).toContain('₦80,000 due');
    expect(stubSender.connectionTexts[0]!.text).toMatch(/https:\/\/checkout\.stub\/RKD-PAY-/);

    /* The merchant hears where it WENT, never "forward it". */
    expect(stubSender.lastText).toContain('Sent ✅ payment details for INV');
    expect(stubSender.lastText).not.toContain('Forward it');

    /* ONE intent. A second ask reuses it — one obligation, one reference
     * — so when Chidi pays there is exactly one thing to reconcile. */
    expect(await intentCount(businessId)).toBe(1);
    await ask('wamid.X1.2');
    expect(await intentCount(businessId)).toBe(1);
    const first = stubSender.connectionTexts[0]!.text;
    const second = stubSender.connectionTexts[1]!.text;
    expect(second).toBe(first);
  });

  it('a Chat-only business gets the details in their own hands, and nothing enters the customer thread', async () => {
    await seedComplete('PN-X1-2', { plan: 'chat' });

    await ask('wamid.X1.3');

    expect(stubSender.connectionTexts).toHaveLength(0);
    expect(stubSender.lastText).toMatch(/Payment link for INV-\d{4}-000001/);
    expect(stubSender.lastText).toContain('Forward it to your customer');
  });

  it('a closed window falls back to the forwardable link rather than a send Meta will refuse', async () => {
    await seedComplete('PN-X1-3', { windowOpen: false });

    await ask('wamid.X1.4');

    expect(stubSender.connectionTexts).toHaveLength(0);
    expect(stubSender.lastText).toContain('Forward it to your customer');
  });
});

describe('collecting money from chat (payments-v1 §160)', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  async function send(text: string, wamid: string) {
    await post(messagePayload('2348031234567', wamid, text));
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    expect(worked).toBe(true);
    while (worked) worked = await runner.runOnce();
  }

  async function activeConnection(businessId: string) {
    await withBusiness(db, businessId, async (tx) => {
      const connection = await paymentsHub.upsertConnection(tx, {
        businessId,
        providerType: 'paystack',
        settlementAccountLast4: '4821',
      });
      await paymentsHub.setConnectionState(tx, connection.id, {
        status: 'active',
        externalSubaccountId: 'ACCT_live1',
      });
    });
  }

  /** An open ₦80,000 invoice for a customer whose email is on file. */
  async function openInvoiceWithEmail(businessId: string, config: ApiConfig) {
    const customer = await customersRepo.createCustomerWithIdentities(db, businessId, 'X81', [
      {
        facet: 'phone',
        ciphertext: encryptFacet('+2348039998888', config.vaultKey, `${businessId}:phone`),
        matchKey: matchKeyFor(businessId, 'phone', '+2348039998888', config.matchKey),
      },
      {
        facet: 'email',
        ciphertext: encryptFacet('adaeze@example.com', config.vaultKey, `${businessId}:email`),
        matchKey: null,
      },
    ]);
    return withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: customer.id,
        customerToken: 'CUSTOMER_X81',
        items: [{ name: 'gown', quantity: 1, unitPriceK: 8_000_000 }],
        subtotalK: 8_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 8_000_000,
        paidK: 0,
        balanceDueK: 8_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-pay',
        actor: 'system',
      }),
    );
  }

  it('who owes me answers from the ledger: numbers, totals, no names', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await openInvoiceWithEmail(business.id, deps.config);

    await send('who owes me', 'wamid.OWES');
    expect(stubSender.lastText).toContain('One invoice is unpaid: ₦80,000 owed to you');
    expect(stubSender.lastText).toMatch(/INV-\d{4}-000001: ₦80,000/);
    expect(stubSender.lastText).not.toContain('CUSTOMER_X81');
  });

  it('payment details with an active connection returns a forwardable link', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await activeConnection(business.id);
    await openInvoiceWithEmail(business.id, deps.config);

    await send('send payment link', 'wamid.PAY1');
    expect(stubSender.lastText).toMatch(/Payment link for INV-\d{4}-000001: ₦80,000 outstanding/);
    expect(stubSender.lastText).toMatch(/https:\/\/checkout\.stub\/RKD-PAY-/);
  });

  it('payment details without a connection links the configured Payments page', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await openInvoiceWithEmail(business.id, deps.config);

    await send('payment details', 'wamid.PAY2');
    expect(stubSender.lastText).toContain('add your settlement account');
    /* REKODA_WEB_URL, through config.webUrl: the only link in the reply, and
     * the last thing in it. */
    expect((stubSender.lastText ?? '').match(/\S+:\/\/\S+/g)).toEqual([
      'https://books.example.test/app/payments',
    ]);
    expect(stubSender.lastText).toMatch(/\nhttps:\/\/books\.example\.test\/app\/payments$/);
    // No bare domain beside the link either.
    expect(
      (stubSender.lastText ?? '').replace('https://books.example.test/app/payments', ''),
    ).not.toMatch(/www\.|[a-z0-9-]\.[a-z]{2,}/i);
  });

  it('payment details without a connection or a web URL names no link at all', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await openInvoiceWithEmail(business.id, deps.config);

    await post(messagePayload('2348031234567', 'wamid.PAY2N', 'payment details'));
    const runner = buildRunner(workerDb, db, { ...deps, config: { ...deps.config, webUrl: null } });
    let worked = await runner.runOnce();
    expect(worked).toBe(true);
    while (worked) worked = await runner.runOnce();

    expect(stubSender.lastText).toContain('open your Rekoda dashboard and go to Payments');
    // No scheme, no www, and no bare `name.tld` a phone would still link.
    expect(stubSender.lastText).not.toMatch(/:\/\/|www\.|[a-z0-9-]\.[a-z]{2,}/i);
  });

  it('a provider outage degrades to an honest sentence, and the next try works', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await activeConnection(business.id);
    await openInvoiceWithEmail(business.id, deps.config);

    intentsProvider.failNextInitializeWith(new Error('Paystack is down'));
    await send('payment details', 'wamid.PAYDOWN');
    expect(stubSender.lastText).toContain('could not reach your payment provider');
    expect(stubSender.lastText).not.toContain('http');

    // The job completed rather than dying in retries, so the next ask succeeds.
    await send('payment details', 'wamid.PAYUP');
    expect(stubSender.lastText).toMatch(/https:\/\/checkout\.stub\/RKD-PAY-/);
  });

  it('payment details with nothing owed says so', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await send('payment details', 'wamid.PAY3');
    expect(stubSender.lastText).toContain('nothing to collect');
  });
});
