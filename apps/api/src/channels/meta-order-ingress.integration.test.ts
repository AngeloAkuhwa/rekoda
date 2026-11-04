/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: every order ingress and the W3 completion gate. Split by concern from
 * meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  conversationsRepo,
  events,
  identity,
  catalogueRepo,
  usageRepo,
  stockRepo,
  wabaRepo,
  withBusiness,
  sql,
} from '@rekoda/db';
import { usagePeriod } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
import { billingRepo, customersRepo, paymentsHub } from '@rekoda/db';
import { encryptFacet } from '@rekoda/core/vault';
import { sealPayload } from '../privacy/payload-vault.js';
import { pumpPaystackEvents } from '../payments/paystack-pump.js';
import { meterAllowance } from '../billing/plan-terms.js';
import {
  db,
  deps,
  intentsProvider,
  orderPayload,
  post,
  stubSender,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';

useMetaWebhookHarness();

/**
 * The WABA catalogue door and the storefront door are now the same door
 * (remediation R2).
 *
 * Before this, `REKODA_COMMAND_PLACE_ORDER` was off unless an environment
 * set it, and both ingresses kept an else branch that called the work
 * function directly. The storefront's branch at least checked entitlement
 * itself; the WABA branch checked nothing. Which gates a customer's order
 * passed through depended on which door they walked in by.
 */
describe('every order ingress goes through PlaceOrder (remediation R2)', () => {
  async function seedCatalogueMerchant(
    phone: string,
    phoneNumberId: string,
    plan: 'integrate' | 'chat',
  ) {
    const user = await identity.upsertUserByPhone(db, phone);
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    /* A fresh trial business holds BOTH capabilities, so refusing one has to
     * be done by pinning the plan rather than by not granting (the same find
     * PR-025 recorded for the storefront). */
    await billingRepo.setPlan(db, {
      businessId: business.id,
      plan,
      expiresAt: null,
      actor: 'operator:test',
    });
    const wig = await withBusiness(db, business.id, async (tx) => {
      await wabaRepo.connectWaba(tx, {
        businessId: business.id,
        wabaId: `waba-${phoneNumberId}`,
        phoneNumberId,
        accessTokenCipher: 'cipher-for-tests',
        tokenTail: '4821',
      });
      return catalogueRepo.createProduct(tx, business.id, { name: 'wig', unitPriceK: 150_000 });
    });
    return { businessId: business.id, wigId: wig.id };
  }

  const orderCount = async (businessId: string) =>
    [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM orders WHERE business_id = ${businessId}::uuid`,
        ),
      )),
    ][0]!.n;

  it('refuses a catalogue order from a plan that does not carry Integrate, and takes nothing', async () => {
    const { businessId, wigId } = await seedCatalogueMerchant(
      '+2348030002261',
      'PN-R2-REFUSE',
      'chat',
    );

    expect(
      (
        await post(
          orderPayload('2349097776111', 'wamid.R2.REFUSE', 'PN-R2-REFUSE', [
            { retailerId: wigId, quantity: 1 },
          ]),
        )
      ).statusCode,
    ).toBe(200);
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* §4.3 rule 1: a refused request consumes nothing. Entitlement runs
     * before the idempotency key, so there is no claim either. */
    expect(await orderCount(businessId)).toBe('0');
    const claims = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM idempotency_records
               WHERE business_id = ${businessId}::uuid`,
        ),
      )),
    ];
    expect(claims[0]!.n).toBe('0');
  });

  it('claims an idempotency key for a catalogue order, which the legacy branch never did', async () => {
    const { businessId, wigId } = await seedCatalogueMerchant(
      '+2348030002262',
      'PN-R2-KEY',
      'integrate',
    );

    await post(
      orderPayload('2349097776222', 'wamid.R2.KEY', 'PN-R2-KEY', [
        { retailerId: wigId, quantity: 1 },
      ]),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(await orderCount(businessId)).toBe('1');
    const claims = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<{ key: string; command_name: string }>(
          sql`SELECT key, command_name FROM idempotency_records
               WHERE business_id = ${businessId}::uuid`,
        ),
      )),
    ];
    /* The webhook's own message id is the retry identity, the same one the
     * ingress already dedupes on. */
    expect(claims).toEqual([{ key: 'meta:wamid.R2.KEY', command_name: 'PlaceOrder' }]);
  });

  it('refuses to place through the legacy branch when the flag is switched off', async () => {
    const { businessId, wigId } = await seedCatalogueMerchant(
      '+2348030002263',
      'PN-R2-LEGACY',
      'integrate',
    );

    await post(
      orderPayload('2349097776333', 'wamid.R2.LEGACY', 'PN-R2-LEGACY', [
        { retailerId: wigId, quantity: 1 },
      ]),
    );
    /* PlaceOrder's 0 is not a rollback (OD-4, OWN-22): the legacy branch was
     * retired, and it must refuse rather than quietly take an order. */
    expect(
      await buildRunner(workerDb, db, {
        ...deps,
        config: { ...deps.config, commandPlaceOrder: false },
      }).runOnce(),
    ).toBe(true);

    expect(await orderCount(businessId)).toBe('0');
    const failed = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<{ last_error: string | null }>(
          sql`SELECT last_error FROM jobs WHERE business_id = ${businessId}::uuid`,
        ),
      )),
    ];
    expect(failed[0]?.last_error).toContain('REKODA_COMMAND_PLACE_ORDER');
  });
});

describe('the W3 completion gate: catalogue to receipt (spec §3.2; PR-089)', () => {
  const OWNER = '+2348030002230';
  const CUSTOMER_WA = '2349097779999';

  /**
   * The whole storefront, stood up the way production stands it up: a
   * merchant on the Integrate plan with a CONNECTED WABA whose token
   * actually decrypts, a counted shelf, an ACTIVE Paystack connection
   * (which provisions its own clearing account, PR-053), and SERVICE
   * capacity granted as a bonus because SERVICE_MESSAGE is sold on no
   * plan until the pricing decision, and 0 means zero.
   */
  async function seedGateMerchant(
    phoneNumberId: string,
    opts: { email?: boolean; capacity?: boolean } = {},
  ) {
    const user = await identity.upsertUserByPhone(db, OWNER);
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    const businessId = business.id;
    await billingRepo.setPlan(db, {
      businessId,
      plan: 'integrate',
      expiresAt: null,
      actor: 'operator:test',
    });

    const wigId = await withBusiness(db, businessId, async (tx) => {
      await wabaRepo.connectWaba(tx, {
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
      const wig = await catalogueRepo.createProduct(tx, businessId, {
        name: 'wig',
        unitPriceK: 150_000,
      });
      const shelfRow = (await stockRepo.productByName(tx, businessId, 'wig'))!;
      await stockRepo.recordDelivery(tx, {
        businessId,
        product: shelfRow,
        quantity: 5,
        costK: 100_000,
        sourceType: 'chat',
      });
      const connection = await paymentsHub.upsertConnection(tx, {
        businessId,
        providerType: 'paystack',
        settlementAccountLast4: '4821',
      });
      await paymentsHub.setConnectionState(tx, connection.id, {
        status: 'active',
        externalSubaccountId: 'ACCT_live1',
      });
      const period = usagePeriod(new Date());
      if (opts.capacity === false) {
        /* Spend the month, rather than assume the plan sells none. Integrate
         * sells 5,000 SERVICE_MESSAGE since PR-117, so "no capacity" is now
         * a merchant who has USED theirs, which is the state the fallback
         * below actually exists for. The figure is read rather than
         * retyped, so a repricing does not silently stop exhausting it. */
        const sold = await meterAllowance(
          deps.config,
          tx,
          businessId,
          'integrate',
          'SERVICE_MESSAGE',
        );
        if (sold > 0) {
          await usageRepo.consumeUnit(tx, businessId, period, 'SERVICE_MESSAGE', sold, sold);
        }
      } else {
        await usageRepo.creditBonus(tx, businessId, period, 'SERVICE_MESSAGE', 5);
      }
      return wig.id;
    });

    /* The customer exists BEFORE the cart, the way a repeat buyer does —
     * same phone anchor the webhook resolves, so the cart lands on this
     * very record. The email is what the Paystack mint needs; it is on
     * file because the merchant saved it, never invented. */
    const resolved = await deps.gateway.resolveStorefrontCustomer(
      businessId,
      'Chidi',
      `+${CUSTOMER_WA}`,
    );
    if (!resolved) throw new Error('fixture: customer did not resolve');
    if (opts.email !== false) {
      await customersRepo.addIdentityFacet(db, businessId, resolved.customerId, {
        facet: 'email',
        ciphertext: encryptFacet('chidi@example.com', deps.config.vaultKey, `${businessId}:email`),
        matchKey: null,
      });
    }
    return { businessId, wigId };
  }

  async function drainAll(): Promise<number> {
    const runner = buildRunner(workerDb, db, deps);
    let ran = 0;
    while (await runner.runOnce()) ran += 1;
    return ran;
  }

  const invoiceOf = async (businessId: string) => {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{
        id: string;
        invoice_number: string;
        status: string;
        total_k: string;
        balance_due_k: string;
      }>(sql`
        SELECT id, invoice_number, status, total_k::bigint AS total_k,
               balance_due_k::bigint AS balance_due_k
        FROM invoices WHERE business_id = ${businessId}::uuid
      `),
    );
    return [...rows][0] ?? null;
  };

  const roleBalance = async (businessId: string, role: string) => {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ k: string }>(sql`
        SELECT COALESCE(SUM(e.debit_k - e.credit_k), 0)::bigint AS k
        FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE e.business_id = ${businessId}::uuid AND a.system_role = ${role}
      `),
    );
    return Number([...rows][0]!.k);
  };

  it('an order from the catalogue reaches a receipt in the merchant thread, books correct end to end', async () => {
    const { businessId, wigId } = await seedGateMerchant('PN-GATE-1');
    /* The owner is active on the business number, so the receipt PDF is
     * deliverable free-form (G-67). */
    await withBusiness(db, businessId, (tx) =>
      conversationsRepo.recordInbound(tx, {
        businessId,
        channel: 'meta',
        kind: 'text',
        body: 'hello',
        providerMessageId: 'wamid.gate-window-1',
      }),
    );

    /* 1 ── the cart, through the real webhook ingress. */
    expect(
      (
        await post(
          orderPayload(CUSTOMER_WA, 'wamid.GATE.1', 'PN-GATE-1', [
            { retailerId: wigId, quantity: 2 },
          ]),
        )
      ).statusCode,
    ).toBe(200);
    await drainAll();

    /* 2 ── validated, invoiced, and the CHECKOUT is with the customer, in
     * their own thread on the merchant's number: the server's figure and
     * the payable link, nothing their device claimed. */
    const invoice = await invoiceOf(businessId);
    expect(invoice).toMatchObject({ status: 'issued', total_k: '300000', balance_due_k: '300000' });
    expect(stubSender.connectionTexts).toHaveLength(1);
    expect(stubSender.connectionTexts[0]).toMatchObject({
      to: `+${CUSTOMER_WA}`,
      phoneNumberId: 'PN-GATE-1',
      accessToken: 'EAAG-merchant-token',
    });
    expect(stubSender.connectionTexts[0]!.text).toContain(invoice!.invoice_number);
    expect(stubSender.connectionTexts[0]!.text).toContain('₦3,000');
    expect(stubSender.connectionTexts[0]!.text).toMatch(/https:\/\/checkout\.stub\/RKD-PAY-/);

    /* The merchant's notice says the link is WITH the customer, not
     * "forward it": the system knows what it just did. */
    const notice = stubSender.sent.find((m) => m.text.includes('New WhatsApp order'));
    expect(notice?.to).toBe(OWNER);
    expect(notice?.text).toContain(invoice!.invoice_number);
    expect(notice?.text).toContain('with your customer');

    /* 3 ── the customer pays: charge.success on the SAME reference the
     * checkout was raised with, verified server-side (§6.3) before one
     * kobo is booked. */
    const intent = await withBusiness(db, businessId, (tx) =>
      paymentsHub.liveIntentForInvoice(tx, businessId, invoice!.id),
    );
    expect(intent).not.toBeNull();
    intentsProvider.willVerify(intent!.reference, { amountK: 300_000, providerFeeK: 4_500 });
    const body = {
      event: 'charge.success',
      data: {
        id: 77_001,
        reference: intent!.reference,
        amount: 300_000,
        currency: 'NGN',
        status: 'success',
        customer: { email: 'chidi@example.com' },
      },
    };
    await events.recordEvent(db, {
      provider: 'paystack',
      eventType: body.event,
      externalId: `77001:${body.event}`,
      payload: sealPayload(body, deps.config.vaultKey, 'paystack', `77001:${body.event}`),
      businessId: null,
    });
    expect(await pumpPaystackEvents({ workerDb, appDb: db, vaultKey: deps.config.vaultKey })).toBe(
      1,
    );
    await drainAll();

    /* 4 ── the gate: paid, receipted, and the receipt lands in the
     * MERCHANT'S OWN THREAD with the confirmed figure (§3.2's last line). */
    expect(await invoiceOf(businessId)).toMatchObject({ status: 'paid', balance_due_k: '0' });
    const delivered = stubSender.lastDocument;
    expect(delivered?.to).toBe(OWNER);
    expect(delivered?.caption).toContain('Money in ✅ ₦3,000 confirmed for');
    expect(delivered?.caption).toContain(invoice!.invoice_number);
    expect(delivered?.bytes.subarray(0, 5).toString()).toBe('%PDF-');

    /* 5 ── the accounting, held to §21.1 invariant 10: the money is where
     * the books say it is. Gross parks in the CONNECTION'S clearing
     * account (settlement moves it to bank with ACTUAL fees, §20); the
     * receivable opened by the invoice is cleared by the payment; no bank,
     * no fee expense yet; the §19.1 estimate is still a RECORD awaiting
     * its settlement. */
    expect(await roleBalance(businessId, 'PAYMENT_PROVIDER_CLEARING')).toBe(300_000);
    expect(await roleBalance(businessId, 'ACCOUNTS_RECEIVABLE')).toBe(0);
    const charges = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ actual_or_estimated: string }>(
        sql`SELECT actual_or_estimated FROM payment_charges WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect([...charges].map((c) => c.actual_or_estimated)).toEqual(['ESTIMATED']);
  });

  it('no email on file: the customer still hears the order stands, the merchant hears no link exists', async () => {
    const { businessId, wigId } = await seedGateMerchant('PN-GATE-2', { email: false });

    await post(
      orderPayload(CUSTOMER_WA, 'wamid.GATE.2', 'PN-GATE-2', [{ retailerId: wigId, quantity: 1 }]),
    );
    await drainAll();

    /* §37 "missing customer email" is a product state, not an error: no
     * link is invented, the order's confirmation still carries the
     * server's figure, and the merchant hears the order landed. */
    const invoice = await invoiceOf(businessId);
    expect(invoice).toMatchObject({ status: 'issued', total_k: '150000' });
    expect(stubSender.connectionTexts).toHaveLength(1);
    expect(stubSender.connectionTexts[0]!.text).toContain('Payment details will follow');
    expect(stubSender.connectionTexts[0]!.text).not.toContain('http');
    const notice = stubSender.sent.find((m) => m.text.includes('New WhatsApp order'));
    expect(notice?.to).toBe(OWNER);
    expect(notice?.text).toContain('could not raise a payment link');
  });

  it('capacity at zero: the checkout falls back to a forwardable link in the merchant thread', async () => {
    const { businessId, wigId } = await seedGateMerchant('PN-GATE-3', { capacity: false });

    await post(
      orderPayload(CUSTOMER_WA, 'wamid.GATE.3', 'PN-GATE-3', [{ retailerId: wigId, quantity: 1 }]),
    );
    await drainAll();

    /* The month's SERVICE_MESSAGE is spent, and spent means spent: the
     * customer leg refuses without consuming, and the link falls back to
     * the merchant to forward — the money can still move. */
    const invoice = await invoiceOf(businessId);
    expect(invoice).toMatchObject({ status: 'issued' });
    expect(stubSender.connectionTexts).toHaveLength(0);
    const forwardable = stubSender.sent.find((m) => m.text.includes('Payment link for'));
    expect(forwardable?.to).toBe(OWNER);
    expect(forwardable?.text).toContain('Forward it to your customer');
    expect(forwardable?.text).toMatch(/https:\/\/checkout\.stub\/RKD-PAY-/);
  });
});
