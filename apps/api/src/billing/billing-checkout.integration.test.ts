/**
 * A merchant paying Rekoda through a Paystack checkout (G-102, OWN-39).
 *
 * The settlement half was already proven elsewhere; these tests pin the way in.
 * The claims: no checkout without a billing email the merchant gave (never an
 * invented one); the email is validated, kept sealed under the vault key and
 * bound to its business, and never lands in the audit trail; Paystack, which
 * refuses to initialise one reference twice, is asked once and every later
 * request (or second tab) gets the same link; and the checkout is Rekoda's own
 * revenue, initialised without a merchant subaccount.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { createDb, identity, sql, subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { loadConfig, type ApiConfig } from '../config.js';
import { StubPaymentProvider } from '../payments/provider.stub.js';
import { applySettledCharge, BillingService } from './billing.service.js';
import { BillingCheckoutService } from './billing-checkout.service.js';

const RUN_SALT = randomBytes(16).toString('hex');
const testKey = (label: string): string =>
  createHash('sha256').update(`${label}:${process.pid}:${RUN_SALT}`).digest('hex');

let urls: Urls;
let appDb: Db;
let ownerDb: Db;
let closeApp: () => Promise<void>;
let closeOwner: () => Promise<void>;
let config: ApiConfig;
let provider: StubPaymentProvider;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 4 }));
  ({ db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 2 }));
  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = testKey('pepper');
  process.env['REKODA_API_SECRET'] = testKey('secret');
  process.env['VAULT_KEY'] = testKey('vault');
  process.env['MATCH_KEY'] = testKey('match');
  config = { ...loadConfig(), paystackSecretKey: 'sk_test_x', paystackPlatformConfirmed: true };
});

afterAll(async () => {
  await closeApp?.();
  await closeOwner?.();
});

beforeEach(async () => {
  await truncateAll(urls);
  provider = new StubPaymentProvider();
});

const plans = (overrides: Partial<ApiConfig> = {}) =>
  new BillingService({ ...config, ...overrides }, appDb);
const checkouts = (overrides: Partial<ApiConfig> = {}) =>
  new BillingCheckoutService({ ...config, ...overrides }, appDb, provider);

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(appDb, `+23481720${String(seq).padStart(4, '0')}`);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Checkout Ltd',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** A first purchase of Chat: one pending charge, owed. */
async function pendingCharge(businessId: string): Promise<{ reference: string; amountK: number }> {
  const answer = await plans().changePlan(businessId, 'chat');
  if (answer.state !== 'payment_required') throw new Error('a first purchase should be payable');
  return { reference: answer.reference, amountK: answer.amountK };
}

const rowOf = async (businessId: string) => {
  const rows = await ownerDb.execute<{ sealed: string | null; set_at: string | null }>(sql`
    SELECT billing_email_sealed AS sealed, billing_email_set_at AS set_at
    FROM businesses WHERE id = ${businessId}::uuid
  `);
  return [...rows][0]!;
};

describe('the billing email', () => {
  it('is asked for when none is on file, and nothing reaches the provider', async () => {
    const businessId = await seedBusiness();
    const { reference } = await pendingCharge(businessId);

    const answer = await checkouts().checkout(businessId, reference, undefined);

    expect(answer).toEqual({ state: 'requires_billing_email' });
    expect(provider.initialized).toEqual([]);
    expect((await rowOf(businessId)).sealed).toBeNull();
  });

  it('is kept sealed, opens only for its own business and never appears in the audit trail', async () => {
    const businessId = await seedBusiness();
    const other = await seedBusiness();
    const { reference } = await pendingCharge(businessId);

    await checkouts().checkout(businessId, reference, '  Ada@Shop.example.ng ');

    const { sealed, set_at } = await rowOf(businessId);
    expect(sealed).not.toBeNull();
    expect(sealed).not.toContain('ada');
    expect(set_at).not.toBeNull();
    const audit = await ownerDb.execute<{ action: string; new_value: unknown }>(sql`
      SELECT action, new_value FROM audit_events WHERE action = 'billing_email_set'
    `);
    expect([...audit]).toHaveLength(1);
    expect(JSON.stringify([...audit])).not.toContain('shop.example.ng');

    /* A blob copied onto another business is refused, not read as theirs. */
    await ownerDb.execute(sql`
      UPDATE businesses SET billing_email_sealed = ${sealed} WHERE id = ${other}::uuid
    `);
    const stolen = await pendingCharge(other);
    await expect(checkouts().checkout(other, stolen.reference, undefined)).rejects.toThrow();
    expect(provider.initialized).toHaveLength(1);
  });

  it.each([
    ['not-an-email', 'invalid'],
    ['support@rekoda.app', 'reserved'],
    [`a@${'b'.repeat(250)}.ng`, 'too_long'],
  ])('refuses %s before anything is stored or sent', async (bad, reason) => {
    const businessId = await seedBusiness();
    const { reference } = await pendingCharge(businessId);

    const answer = await checkouts().checkout(businessId, reference, bad);

    expect(answer).toEqual({ state: 'invalid_billing_email', reason });
    expect(provider.initialized).toEqual([]);
    expect((await rowOf(businessId)).sealed).toBeNull();
  });

  it('is reused for the next charge without asking again', async () => {
    const businessId = await seedBusiness();
    const first = await pendingCharge(businessId);
    await checkouts().checkout(businessId, first.reference, 'ada@shop.example.ng');
    await withBusiness(appDb, businessId, (tx) =>
      applySettledCharge(tx, {
        businessId,
        reference: first.reference,
        paidAmountK: first.amountK,
        providerReference: 'psk_1',
        when: new Date(),
        config: config as never,
      }),
    );
    const pack = await plans().buyPack(businessId, 'messages_100');
    if (pack.state !== 'payment_required')
      throw new Error(`a pack should be payable: ${JSON.stringify(pack)}`);

    const answer = await checkouts().checkout(businessId, pack.reference, undefined);

    expect(answer).toMatchObject({ state: 'ready', reference: pack.reference });
    expect(provider.initialized[1]?.customerEmail).toBe('ada@shop.example.ng');
  });
});

describe('the checkout', () => {
  it('is initialised for the charge’s own reference and amount, as Rekoda revenue', async () => {
    const businessId = await seedBusiness();
    const { reference, amountK } = await pendingCharge(businessId);

    const answer = await checkouts().checkout(businessId, reference, 'ada@shop.example.ng');

    expect(answer).toEqual({
      state: 'ready',
      reference,
      checkoutUrl: `https://checkout.stub/${reference}`,
      amountK,
    });
    expect(provider.initialized).toEqual([
      {
        reference,
        amountK,
        currency: 'NGN',
        customerEmail: 'ada@shop.example.ng',
        subaccountCode: null,
      },
    ]);
  });

  it('asks Paystack once: a repeat gets the same link, with no email needed', async () => {
    const businessId = await seedBusiness();
    const { reference } = await pendingCharge(businessId);
    const first = await checkouts().checkout(businessId, reference, 'ada@shop.example.ng');

    const again = await checkouts().checkout(businessId, reference, undefined);

    expect(again).toEqual(first);
    expect(provider.initialized).toHaveLength(1);
  });

  it('gives two tabs that click at once the same link', async () => {
    const businessId = await seedBusiness();
    const { reference } = await pendingCharge(businessId);

    const [a, b] = await Promise.all([
      checkouts().checkout(businessId, reference, 'ada@shop.example.ng'),
      checkouts().checkout(businessId, reference, 'ada@shop.example.ng'),
    ]);

    expect(a).toMatchObject({ state: 'ready' });
    expect(b).toEqual(a);
    const stored = await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.chargeByReference(tx, businessId, reference),
    );
    expect(stored?.checkoutUrl).toBe((a as { checkoutUrl: string }).checkoutUrl);
  });

  it('survives a provider outage: no link is kept, and the retry works', async () => {
    const businessId = await seedBusiness();
    const { reference } = await pendingCharge(businessId);
    provider.failNextInitializeWith(new Error('paystack down'));

    await expect(
      checkouts().checkout(businessId, reference, 'ada@shop.example.ng'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    const after = await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.chargeByReference(tx, businessId, reference),
    );
    expect(after?.checkoutUrl).toBeNull();

    const retry = await checkouts().checkout(businessId, reference, undefined);
    expect(retry).toMatchObject({ state: 'ready', reference });
  });
});

describe('what may be paid', () => {
  it('refuses another business’s charge as unknown', async () => {
    const mine = await seedBusiness();
    const theirs = await seedBusiness();
    const { reference } = await pendingCharge(theirs);

    const answer = await checkouts().checkout(mine, reference, 'ada@shop.example.ng');

    expect(answer).toEqual({ state: 'unavailable', reason: 'unknown_charge' });
    expect(provider.initialized).toEqual([]);
  });

  it('refuses a charge that is already paid', async () => {
    const businessId = await seedBusiness();
    const { reference, amountK } = await pendingCharge(businessId);
    await withBusiness(appDb, businessId, (tx) =>
      applySettledCharge(tx, {
        businessId,
        reference,
        paidAmountK: amountK,
        providerReference: 'psk_paid',
        when: new Date(),
        config: config as never,
      }),
    );

    const answer = await checkouts().checkout(businessId, reference, 'ada@shop.example.ng');

    expect(answer).toEqual({ state: 'unavailable', reason: 'not_pending' });
    expect(provider.initialized).toEqual([]);
  });

  it('refuses a charge of nothing', async () => {
    const businessId = await seedBusiness();
    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.openCharge(tx, {
        businessId,
        kind: 'upgrade',
        plan: 'complete',
        amountK: 0,
        reference: 'RKD-SUB-20261024-AAAAAA',
      }),
    );

    const answer = await checkouts().checkout(businessId, 'RKD-SUB-20261024-AAAAAA', 'a@b.ng');

    expect(answer).toEqual({ state: 'unavailable', reason: 'nothing_to_pay' });
  });

  it('says so when payments are not configured, and holds a live key until Paystack confirms', async () => {
    const businessId = await seedBusiness();
    const { reference } = await pendingCharge(businessId);

    expect(
      await checkouts({ paystackSecretKey: '' }).checkout(businessId, reference, 'a@shop.ng'),
    ).toEqual({ state: 'unavailable', reason: 'payments_not_configured' });
    expect(
      await checkouts({
        paystackSecretKey: 'sk_live_x',
        paystackPlatformConfirmed: false,
      }).checkout(businessId, reference, 'a@shop.ng'),
    ).toEqual({ state: 'unavailable', reason: 'awaiting_platform_confirmation' });
    expect(provider.initialized).toEqual([]);
    expect((await rowOf(businessId)).sealed).toBeNull();
  });
});
