/**
 * Proving the billing email's mailbox (G-102 slice 2b, OWN-51).
 *
 * A live subscription payment must not start against an address nobody has
 * shown they can read. The claims pinned here: the link is a single-use,
 * expiring secret whose hash alone is stored; it is bound to the address it
 * was mailed to; it only works for the business that asked; requests are rate
 * limited by the database clock; a failed send costs nothing; the address
 * never reaches the audit trail; a live key waits for the proof and a test key
 * does not.
 */
// The billing email verification suite. Split by concern; the rest of this suite is in billing-
// email-verification.integration.test.ts.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, sql, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls, settlementDb } from '@rekoda/db/testing';
import { loadConfig, type ApiConfig } from '../config.js';
import { MockEmailSender, NoEmailSender } from '../email/email.port.js';
import { StubPaymentProvider } from '../payments/provider.stub.js';
import { BillingService } from './billing.service.js';
import { BillingCheckoutService } from './billing-checkout.service.js';
import { BillingEmailService } from './billing-email.service.js';

const RUN_SALT = randomBytes(16).toString('hex');
const testKey = (label: string): string =>
  createHash('sha256').update(`${label}:${process.pid}:${RUN_SALT}`).digest('hex');

let urls: Urls;
let appDb: Db;
let closeApp: () => Promise<void>;
let config: ApiConfig;
let provider: StubPaymentProvider;
let mail: MockEmailSender;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 6 }));
  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = testKey('pepper');
  process.env['REKODA_API_SECRET'] = testKey('secret');
  process.env['VAULT_KEY'] = testKey('vault');
  process.env['MATCH_KEY'] = testKey('match');
  config = {
    ...loadConfig(),
    paystackSecretKey: 'sk_test_x',
    paystackPlatformConfirmed: true,
    webUrl: 'https://app.rekoda.test',
  };
  provider = new StubPaymentProvider();
});

afterAll(async () => {
  await closeApp?.();
});

beforeEach(async () => {
  await truncateAll(urls);
  provider.reset();
  mail = new MockEmailSender();
});

const emails = (sender: MockEmailSender | NoEmailSender = mail, cfg: ApiConfig = config) =>
  new BillingEmailService(cfg, appDb, sender);
const checkouts = (cfg: ApiConfig = config) => new BillingCheckoutService(cfg, appDb, provider);
const liveConfig = (): ApiConfig => ({ ...config, paystackSecretKey: 'sk_live_x' });

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(appDb, `+23481740${String(seq).padStart(4, '0')}`);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Mailbox Ltd',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const EMAIL = 'ada@shop.example.ng';
const OTHER = 'chidi@shop.example.ng';

const tokenFrom = (message: { text: string }): string => {
  const match = /#token=([^\s]+)/.exec(message.text);
  if (!match) throw new Error('the message carried no link');
  return decodeURIComponent(match[1]!);
};

/** Ask for a link and hand back the token the mock "sent". */
async function mailed(businessId: string, address?: string): Promise<string> {
  const answer = await emails().requestVerification(businessId, address);
  expect(answer.state).toBe('sent');
  return tokenFrom(mail.outbox.at(-1)!);
}

const sql1 = async <T extends Record<string, unknown>>(
  businessId: string,
  query: ReturnType<typeof sql>,
) => withBusiness(appDb, businessId, async (tx) => [...(await tx.execute<T>(query))]);

/**
 * Pretend the last request was `seconds` ago, past the cooldown. Time moves for both limits: the
 * business's own links and the per-address counter (SUB-02a, OWN-58), which only the owner can
 * reach. Moving one clock and not the other would test a moment that cannot happen.
 */
async function age(businessId: string, seconds: number): Promise<void> {
  await sql1(
    businessId,
    sql`UPDATE billing_email_verifications
        SET created_at = created_at - make_interval(secs => ${seconds}),
            expires_at = expires_at - make_interval(secs => ${seconds})
        WHERE business_id = ${businessId}::uuid`,
  );
  const { db: owner, close } = createDb(urls.owner, { max: 1 });
  try {
    await owner.execute(
      sql`UPDATE billing_email_address_requests
          SET created_at = created_at - make_interval(secs => ${seconds})`,
    );
  } finally {
    await close();
  }
}

async function pendingCharge(businessId: string): Promise<string> {
  const answer = await new BillingService(config, appDb, settlementDb()).changePlan(
    businessId,
    'chat',
  );
  if (answer.state !== 'payment_required') throw new Error('a first purchase should be payable');
  return answer.reference;
}

describe('a live payment', () => {
  it('waits for the mailbox to be proven, and starts nothing at Paystack', async () => {
    const businessId = await seedBusiness();
    const reference = await pendingCharge(businessId);
    const answer = await checkouts(liveConfig()).checkout(businessId, reference, EMAIL);
    expect(answer).toEqual({
      state: 'requires_billing_email_verification',
      maskedEmail: 'a**@shop.example.ng',
    });
    expect(provider.initialized).toHaveLength(0);
    /* The address was saved, so the page can go straight to "send me the link". */
    expect((await emails().status(businessId)).maskedEmail).toBe('a**@shop.example.ng');
  });

  it('proceeds once the mailbox is proven', async () => {
    const businessId = await seedBusiness();
    const reference = await pendingCharge(businessId);
    await checkouts(liveConfig()).checkout(businessId, reference, EMAIL);
    await emails().confirm(businessId, await mailed(businessId));
    const answer = await checkouts(liveConfig()).checkout(businessId, reference, undefined);
    expect(answer.state).toBe('ready');
    expect(provider.initialized).toHaveLength(1);
  });

  it('keeps the proof when the same address is re-submitted at checkout', async () => {
    const businessId = await seedBusiness();
    const reference = await pendingCharge(businessId);
    await checkouts(liveConfig()).checkout(businessId, reference, EMAIL);
    await emails().confirm(businessId, await mailed(businessId));
    expect((await checkouts(liveConfig()).checkout(businessId, reference, EMAIL)).state).toBe(
      'ready',
    );
  });

  it('asks again when a different address is given at checkout', async () => {
    const businessId = await seedBusiness();
    const reference = await pendingCharge(businessId);
    await checkouts(liveConfig()).checkout(businessId, reference, EMAIL);
    await emails().confirm(businessId, await mailed(businessId));
    const answer = await checkouts(liveConfig()).checkout(businessId, reference, OTHER);
    expect(answer).toMatchObject({ state: 'requires_billing_email_verification' });
    expect(provider.initialized).toHaveLength(0);
  });

  it('does not hand back the old link for a different address', async () => {
    const businessId = await seedBusiness();
    const reference = await pendingCharge(businessId);
    /* A link started under the old address while the mailbox was proven. */
    await checkouts().checkout(businessId, reference, EMAIL);
    await emails().confirm(businessId, await mailed(businessId));
    const first = await checkouts(liveConfig()).checkout(businessId, reference, undefined);
    expect(first.state).toBe('ready');

    const answer = await checkouts(liveConfig()).checkout(businessId, reference, OTHER);
    expect(answer).toMatchObject({
      state: 'requires_billing_email_verification',
      maskedEmail: 'c****@shop.example.ng',
    });
    expect((await emails().status(businessId)).verified).toBe(false);
  });

  it('does not hand back the old link once the address was changed by asking for a link', async () => {
    const businessId = await seedBusiness();
    const reference = await pendingCharge(businessId);
    await checkouts().checkout(businessId, reference, EMAIL);
    await emails().confirm(businessId, await mailed(businessId));
    expect((await checkouts(liveConfig()).checkout(businessId, reference, undefined)).state).toBe(
      'ready',
    );

    /* The address changes through the verification route, not through checkout. */
    await age(businessId, 61);
    await emails().requestVerification(businessId, OTHER);

    /* No address given, and none needed: the one on file is the new, unproven one. */
    expect(await checkouts(liveConfig()).checkout(businessId, reference, undefined)).toMatchObject({
      state: 'requires_billing_email_verification',
    });

    /* Proven, the old session still is not reused: it was started for the other address. */
    await emails().confirm(businessId, tokenFrom(mail.outbox.at(-1)!));
    const initialisedBefore = provider.initialized.length;
    const answer = await checkouts(liveConfig()).checkout(businessId, reference, undefined);
    expect(answer.state).toBe('ready');
    expect(provider.initialized).toHaveLength(initialisedBefore + 1);
    expect(provider.initialized.at(-1)!.customerEmail).toBe(OTHER);
  });

  it('holds back a link when the address changes while the provider is answering', async () => {
    const businessId = await seedBusiness();
    const reference = await pendingCharge(businessId);
    /* Proven under the first address; no session yet. */
    await emails().confirm(businessId, await mailed(businessId, EMAIL));
    await age(businessId, 61);
    const realInitialize = provider.initializeTransaction.bind(provider);
    let release!: () => void;
    let entered!: () => void;
    const providerEntered = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    provider.initializeTransaction = async (input) => {
      entered();
      await gate;
      return realInitialize(input);
    };
    try {
      const pending = checkouts(liveConfig()).checkout(businessId, reference, undefined);
      await providerEntered;
      await emails().requestVerification(businessId, OTHER);
      release();
      expect(await pending).toMatchObject({ state: 'requires_billing_email_verification' });
    } finally {
      provider.initializeTransaction = realInitialize;
    }
  });

  it('does not reuse a session from before revisions were recorded once the address changed', async () => {
    const businessId = await seedBusiness();
    const reference = await pendingCharge(businessId);
    await checkouts().checkout(businessId, reference, EMAIL);
    /* Make the session look like one created before migration 0174. */
    await sql1(
      businessId,
      sql`UPDATE subscription_charge_attempts SET email_revision = NULL
          WHERE business_id = ${businessId}::uuid`,
    );
    await emails().confirm(businessId, await mailed(businessId));
    await age(businessId, 61);
    await emails().requestVerification(businessId, OTHER);
    await emails().confirm(businessId, tokenFrom(mail.outbox.at(-1)!));

    const answer = await checkouts(liveConfig()).checkout(businessId, reference, undefined);
    expect(answer.state).toBe('ready');
    expect(provider.initialized.at(-1)!.customerEmail).toBe(OTHER);
  });

  it('does not hand back a cached link on a live key while the mailbox is unproven', async () => {
    const businessId = await seedBusiness();
    const reference = await pendingCharge(businessId);
    /* A session started under a test key, never proven. */
    expect((await checkouts().checkout(businessId, reference, EMAIL)).state).toBe('ready');

    const answer = await checkouts(liveConfig()).checkout(businessId, reference, undefined);
    expect(answer).toMatchObject({
      state: 'requires_billing_email_verification',
      maskedEmail: 'a**@shop.example.ng',
    });
  });

  it('does not give a waiting request the sibling link for a different address', async () => {
    const businessId = await seedBusiness();
    const reference = await pendingCharge(businessId);
    const realInitialize = provider.initializeTransaction.bind(provider);
    let release!: () => void;
    let entered!: () => void;
    const providerEntered = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    provider.initializeTransaction = async (input) => {
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return realInitialize(input);
    };
    try {
      const a = checkouts().checkout(businessId, reference, EMAIL);
      await providerEntered;
      const b = checkouts().checkout(businessId, reference, OTHER, { siblingWaitMs: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      const [first_, second] = await Promise.all([a, b]);
      expect(first_.state).toBe('ready');
      expect(second.state).toBe('ready');
      if (first_.state === 'ready' && second.state === 'ready') {
        expect(second.checkoutUrl).not.toBe(first_.checkoutUrl);
      }
      expect(provider.initialized.at(-1)!.customerEmail).toBe(OTHER);
      expect((await emails().status(businessId)).maskedEmail).toBe('c****@shop.example.ng');
    } finally {
      provider.initializeTransaction = realInitialize;
    }
  });

  it('does not hand out an adopted pre-attempts link on a live key while the mailbox is unproven', async () => {
    const businessId = await seedBusiness();
    const reference = await pendingCharge(businessId);
    /* An address on file but never proven, and a link stored before attempts existed. */
    await emails().requestVerification(businessId, EMAIL);
    await sql1(
      businessId,
      sql`UPDATE subscription_charges
          SET checkout_url = 'https://checkout.stub/legacy', checkout_started_at = now()
          WHERE business_id = ${businessId}::uuid AND reference = ${reference}`,
    );
    const answer = await checkouts(liveConfig()).checkout(businessId, reference, undefined);
    expect(answer).toMatchObject({ state: 'requires_billing_email_verification' });
    expect(provider.initialized).toHaveLength(0);
  });

  it('replaces a session from before revisions were recorded on a live key once the mailbox is proven', async () => {
    const businessId = await seedBusiness();
    const reference = await pendingCharge(businessId);
    await checkouts().checkout(businessId, reference, EMAIL);
    await emails().confirm(businessId, await mailed(businessId));
    await sql1(
      businessId,
      sql`UPDATE subscription_charge_attempts SET email_revision = NULL
          WHERE business_id = ${businessId}::uuid`,
    );
    const before = provider.initialized.length;

    const first = await checkouts(liveConfig()).checkout(businessId, reference, undefined);
    expect(first.state).toBe('ready');
    expect(provider.initialized).toHaveLength(before + 1);
    const revisions = await sql1<{ email_revision: number | null; status: string }>(
      businessId,
      sql`SELECT email_revision, status FROM subscription_charge_attempts
          WHERE business_id = ${businessId}::uuid AND status = 'active'`,
    );
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.email_revision).not.toBeNull();
    const modes = await sql1<{ provider_live: boolean | null }>(
      businessId,
      sql`SELECT provider_live FROM subscription_charge_attempts
          WHERE business_id = ${businessId}::uuid AND status = 'active'`,
    );
    expect(modes[0]!.provider_live).toBe(true);

    /* And it is not replaced again: the new session carries its revision. */
    expect((await checkouts(liveConfig()).checkout(businessId, reference, undefined)).state).toBe(
      'ready',
    );
    expect(provider.initialized).toHaveLength(before + 1);
  });

  it('does not present a test-key link as a ready live checkout once the mailbox is proven', async () => {
    const businessId = await seedBusiness();
    const reference = await pendingCharge(businessId);
    const first = await checkouts().checkout(businessId, reference, EMAIL);
    expect(first.state).toBe('ready');
    await emails().confirm(businessId, await mailed(businessId));
    const before = provider.initialized.length;

    const answer = await checkouts(liveConfig()).checkout(businessId, reference, undefined);
    expect(answer.state).toBe('ready');
    if (first.state === 'ready' && answer.state === 'ready') {
      expect(answer.checkoutUrl).not.toBe(first.checkoutUrl);
    }
    expect(provider.initialized).toHaveLength(before + 1);
    /* And the live session is then reused, not replaced again. */
    expect((await checkouts(liveConfig()).checkout(businessId, reference, undefined)).state).toBe(
      'ready',
    );
    expect(provider.initialized).toHaveLength(before + 1);
  });

  it('does not present a live-key link under a test key either', async () => {
    const businessId = await seedBusiness();
    const reference = await pendingCharge(businessId);
    await emails().confirm(businessId, await mailed(businessId, EMAIL));
    const first = await checkouts(liveConfig()).checkout(businessId, reference, undefined);
    expect(first.state).toBe('ready');
    const before = provider.initialized.length;

    const answer = await checkouts().checkout(businessId, reference, undefined);
    expect(answer.state).toBe('ready');
    if (first.state === 'ready' && answer.state === 'ready') {
      expect(answer.checkoutUrl).not.toBe(first.checkoutUrl);
    }
    expect(provider.initialized).toHaveLength(before + 1);
  });

  it('starts a fresh session for a different address on a test key', async () => {
    const businessId = await seedBusiness();
    const reference = await pendingCharge(businessId);
    const first = await checkouts().checkout(businessId, reference, EMAIL);
    expect(first.state).toBe('ready');
    const second = await checkouts().checkout(businessId, reference, OTHER);
    expect(second.state).toBe('ready');
    expect(provider.initialized.map((i) => i.customerEmail)).toEqual([EMAIL, OTHER]);
  });

  it('does not make a test key wait', async () => {
    const businessId = await seedBusiness();
    const reference = await pendingCharge(businessId);
    expect((await checkouts().checkout(businessId, reference, EMAIL)).state).toBe('ready');
  });
});
