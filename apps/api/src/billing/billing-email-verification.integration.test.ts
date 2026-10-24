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
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, sql, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
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

/** Pretend the last request was `seconds` ago, past the cooldown. */
const age = (businessId: string, seconds: number) =>
  sql1(
    businessId,
    sql`UPDATE billing_email_verifications
        SET created_at = created_at - make_interval(secs => ${seconds}),
            expires_at = expires_at - make_interval(secs => ${seconds})
        WHERE business_id = ${businessId}::uuid`,
  );

async function pendingCharge(businessId: string): Promise<string> {
  const answer = await new BillingService(config, appDb).changePlan(businessId, 'chat');
  if (answer.state !== 'payment_required') throw new Error('a first purchase should be payable');
  return answer.reference;
}

describe('who may touch the verification evidence', () => {
  it('gives the worker role nothing on it, and the app role no delete', async () => {
    const businessId = await seedBusiness();
    const rows = await sql1<{ worker: boolean; app_delete: boolean; app_write: boolean }>(
      businessId,
      sql`SELECT
            has_table_privilege('rekoda_worker', 'billing_email_verifications',
                                'SELECT,INSERT,UPDATE,DELETE') AS worker,
            has_table_privilege('rekoda_app', 'billing_email_verifications', 'DELETE') AS app_delete,
            has_table_privilege('rekoda_app', 'billing_email_verifications', 'INSERT') AS app_write`,
    );
    expect(rows[0]).toEqual({ worker: false, app_delete: false, app_write: true });
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      const one = await sql1<{ ok: boolean }>(
        businessId,
        sql`SELECT has_table_privilege('rekoda_worker', 'billing_email_verifications', ${privilege}) AS ok`,
      );
      expect(one[0]!.ok, privilege).toBe(false);
    }
  });
});

describe('the status the page shows', () => {
  it('has no address and no proof before one is given', async () => {
    const businessId = await seedBusiness();
    expect(await emails().status(businessId)).toEqual({
      maskedEmail: null,
      verified: false,
      canSend: true,
    });
  });

  it('shows the address masked, never whole', async () => {
    const businessId = await seedBusiness();
    await emails().requestVerification(businessId, EMAIL);
    const status = await emails().status(businessId);
    expect(status.maskedEmail).toBe('a**@shop.example.ng');
    expect(JSON.stringify(status)).not.toContain('ada@');
  });

  it('says it cannot send while no sender is configured', async () => {
    const businessId = await seedBusiness();
    expect((await emails(new NoEmailSender()).status(businessId)).canSend).toBe(false);
    expect((await emails(mail, { ...config, webUrl: null }).status(businessId)).canSend).toBe(
      false,
    );
  });
});

describe('asking for a link', () => {
  it('needs an address', async () => {
    const businessId = await seedBusiness();
    expect(await emails().requestVerification(businessId, undefined)).toEqual({
      state: 'requires_billing_email',
    });
    expect(mail.outbox).toHaveLength(0);
  });

  it('refuses a bad address before anything is stored or sent', async () => {
    const businessId = await seedBusiness();
    expect(await emails().requestVerification(businessId, 'not-an-email')).toMatchObject({
      state: 'invalid_billing_email',
    });
    expect(mail.outbox).toHaveLength(0);
    expect((await emails().status(businessId)).maskedEmail).toBeNull();
  });

  it('mails the link to the address, with the token in the fragment only', async () => {
    const businessId = await seedBusiness();
    const answer = await emails().requestVerification(businessId, EMAIL);
    expect(answer).toEqual({ state: 'sent', maskedEmail: 'a**@shop.example.ng' });
    expect(mail.outbox).toHaveLength(1);
    expect(mail.outbox[0]!.to).toBe(EMAIL);
    const link = /https:\/\/\S+/.exec(mail.outbox[0]!.text)![0];
    const url = new URL(link);
    expect(url.pathname).toBe('/app/billing/confirm-email');
    expect(url.search).toBe('');
    expect(url.hash).toMatch(/^#token=[A-Za-z0-9_-]{43}$/);
  });

  it('stores only the hash of the token', async () => {
    const businessId = await seedBusiness();
    const token = await mailed(businessId, EMAIL);
    const rows = await sql1<{ token_hash: string }>(
      businessId,
      sql`SELECT token_hash FROM billing_email_verifications WHERE business_id = ${businessId}::uuid`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(rows[0]!.token_hash).not.toContain(token);
  });

  it('keeps the address out of the audit trail', async () => {
    const businessId = await seedBusiness();
    const token = await mailed(businessId, EMAIL);
    await emails().confirm(businessId, token);
    const rows = await sql1<{ action: string; new_value: unknown }>(
      businessId,
      sql`SELECT action, new_value FROM audit_events
          WHERE business_id = ${businessId}::uuid AND action LIKE 'billing_email%'`,
    );
    expect(rows.map((r) => r.action).sort()).toEqual([
      'billing_email_set',
      'billing_email_verification_requested',
      'billing_email_verified',
    ]);
    const everything = JSON.stringify(rows);
    expect(everything).not.toContain('ada');
    expect(everything).not.toContain('shop.example');
    expect(everything).not.toContain(token);
  });

  it('says so, and sends nothing, while no sender is configured', async () => {
    const businessId = await seedBusiness();
    expect(await emails(new NoEmailSender()).requestVerification(businessId, EMAIL)).toEqual({
      state: 'unavailable',
      reason: 'email_not_configured',
    });
    expect(
      await emails(mail, { ...config, webUrl: null }).requestVerification(businessId, EMAIL),
    ).toEqual({
      state: 'unavailable',
      reason: 'email_not_configured',
    });
    expect(mail.outbox).toHaveLength(0);
  });

  it('gives the allowance back when the send fails', async () => {
    const businessId = await seedBusiness();
    mail.failNext = true;
    expect(await emails().requestVerification(businessId, EMAIL)).toEqual({
      state: 'unavailable',
      reason: 'send_failed',
    });
    /* The link that never left cannot be used, and the merchant may try again at once. */
    const retry = await emails().requestVerification(businessId, undefined);
    expect(retry.state).toBe('sent');
    const unspent = await sql1<{ n: number }>(
      businessId,
      sql`SELECT count(*)::int AS n FROM billing_email_verifications
          WHERE business_id = ${businessId}::uuid AND consumed_at IS NULL`,
    );
    expect(unspent[0]!.n).toBe(1);
  });
});

describe('rate limits', () => {
  it('mails once for a double click, by the database clock', async () => {
    const businessId = await seedBusiness();
    await mailed(businessId, EMAIL);
    const again = await emails().requestVerification(businessId, undefined);
    expect(again.state).toBe('rate_limited');
    if (again.state === 'rate_limited') {
      expect(again.retryAfterSeconds).toBeGreaterThan(0);
      expect(again.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
    expect(mail.outbox).toHaveLength(1);
    await age(businessId, 61);
    expect((await emails().requestVerification(businessId, undefined)).state).toBe('sent');
  });

  it('allows five an hour and no more', async () => {
    const businessId = await seedBusiness();
    for (let i = 0; i < 5; i += 1) {
      expect((await emails().requestVerification(businessId, EMAIL)).state).toBe('sent');
      await age(businessId, 61);
    }
    expect(await emails().requestVerification(businessId, undefined)).toMatchObject({
      state: 'rate_limited',
    });
    expect(mail.outbox).toHaveLength(5);
  });

  it('does not count another business against this one', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    await mailed(a, EMAIL);
    expect((await emails().requestVerification(b, OTHER)).state).toBe('sent');
  });
});

describe('using a link', () => {
  it('proves the mailbox, once', async () => {
    const businessId = await seedBusiness();
    const token = await mailed(businessId, EMAIL);
    expect(await emails().confirm(businessId, token)).toEqual({ state: 'verified' });
    expect((await emails().status(businessId)).verified).toBe(true);
    expect(await emails().confirm(businessId, token)).toEqual({ state: 'invalid' });
  });

  it('tells a verified owner there is nothing to do', async () => {
    const businessId = await seedBusiness();
    await emails().confirm(businessId, await mailed(businessId, EMAIL));
    expect(await emails().requestVerification(businessId, undefined)).toEqual({
      state: 'already_verified',
      maskedEmail: 'a**@shop.example.ng',
    });
  });

  it('refuses a made-up token', async () => {
    const businessId = await seedBusiness();
    await mailed(businessId, EMAIL);
    expect(await emails().confirm(businessId, 'A'.repeat(43))).toEqual({ state: 'invalid' });
    expect((await emails().status(businessId)).verified).toBe(false);
  });

  it('refuses an expired link', async () => {
    const businessId = await seedBusiness();
    const token = await mailed(businessId, EMAIL);
    await age(businessId, 2 * 60 * 60);
    expect(await emails().confirm(businessId, token)).toEqual({ state: 'expired' });
    expect((await emails().status(businessId)).verified).toBe(false);
  });

  it("does not work for another business's session", async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    const token = await mailed(a, EMAIL);
    expect(await emails().confirm(b, token)).toEqual({ state: 'invalid' });
    expect((await emails().status(a)).verified).toBe(false);
    expect(await emails().confirm(a, token)).toEqual({ state: 'verified' });
  });

  it('spends every outstanding link with the first one used', async () => {
    const businessId = await seedBusiness();
    const first = await mailed(businessId, EMAIL);
    await age(businessId, 61);
    const second = await mailed(businessId);
    expect(await emails().confirm(businessId, second)).toEqual({ state: 'verified' });
    expect(await emails().confirm(businessId, first)).toEqual({ state: 'invalid' });
  });
});

describe('changing the address', () => {
  it('voids the links mailed to the old one', async () => {
    const businessId = await seedBusiness();
    const oldToken = await mailed(businessId, EMAIL);
    await age(businessId, 61);
    await mailed(businessId, OTHER);
    expect(mail.outbox.at(-1)!.to).toBe(OTHER);
    expect(await emails().confirm(businessId, oldToken)).toEqual({ state: 'address_changed' });
    expect((await emails().status(businessId)).verified).toBe(false);
  });

  it('voids the old link even when both addresses were saved at the same instant', async () => {
    /* Both requests captured the same clock reading before taking the lock (Codex P2). */
    const businessId = await seedBusiness();
    const same = new Date('2026-10-24T12:00:00.000Z');
    expect((await emails().requestVerification(businessId, EMAIL, same)).state).toBe('sent');
    const oldToken = tokenFrom(mail.outbox.at(-1)!);
    await age(businessId, 61);
    expect((await emails().requestVerification(businessId, OTHER, same)).state).toBe('sent');
    expect(await emails().confirm(businessId, oldToken)).toEqual({ state: 'address_changed' });
    expect((await emails().status(businessId)).verified).toBe(false);
  });

  it('clears a proof the old address had earned', async () => {
    const businessId = await seedBusiness();
    await emails().confirm(businessId, await mailed(businessId, EMAIL));
    await age(businessId, 61);
    expect(await emails().requestVerification(businessId, OTHER)).toMatchObject({ state: 'sent' });
    expect((await emails().status(businessId)).verified).toBe(false);
  });

  it('keeps the proof when the same address is given again', async () => {
    const businessId = await seedBusiness();
    await emails().confirm(businessId, await mailed(businessId, EMAIL));
    expect(await emails().requestVerification(businessId, EMAIL)).toMatchObject({
      state: 'already_verified',
    });
    expect((await emails().status(businessId)).verified).toBe(true);
  });
});

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

  it('replaces a session with no recorded revision on a live key even when the address is unchanged', async () => {
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
