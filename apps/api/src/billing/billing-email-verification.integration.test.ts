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
import {
  EmailDeliveryUncertainError,
  MockEmailSender,
  NoEmailSender,
  type EmailSender,
} from '../email/email.port.js';
import { EmailSuppressedError } from '../email/suppressing.sender.js';
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
 * Pretend the last request was `seconds` ago, past the cooldown. Time passes for the per-address
 * counter too (OWN-58), which only the owner may rewrite.
 */
const age = async (businessId: string, seconds: number): Promise<void> => {
  await sql1(
    businessId,
    sql`UPDATE billing_email_verifications
        SET created_at = created_at - make_interval(secs => ${seconds}),
            expires_at = expires_at - make_interval(secs => ${seconds})
        WHERE business_id = ${businessId}::uuid`,
  );
  await ageAddressCounter(seconds);
};

/** Move every request in the shared per-address counter back by `seconds` (as the owner). */
async function ageAddressCounter(seconds: number): Promise<void> {
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
      outstandingLink: null,
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

  it('says the address cannot receive Rekoda mail, not "try again", when it is suppressed', async () => {
    const businessId = await seedBusiness();
    const suppressed: EmailSender = {
      available: true,
      send: async () => {
        throw new EmailSuppressedError();
      },
    };
    const answer = await new BillingEmailService(config, appDb, suppressed).requestVerification(
      businessId,
      EMAIL,
    );
    expect(answer).toEqual({ state: 'unavailable', reason: 'address_unusable' });
    /* Nothing left, so the link is spent and the merchant may fix the address at once. */
    const retry = await emails().requestVerification(businessId, undefined);
    expect(retry.state).toBe('sent');
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

describe('an uncertain hand-over to the email provider (billing Slice C)', () => {
  const links = (businessId: string) =>
    sql1<{ voided: boolean; outcome: string | null; consumed: boolean }>(
      businessId,
      sql`SELECT voided_at IS NOT NULL AS voided, send_outcome AS outcome,
                 consumed_at IS NOT NULL AS consumed
          FROM billing_email_verifications WHERE business_id = ${businessId}::uuid
          ORDER BY created_at`,
    );

  it('asks once more with the same key, and a lost response mails the link exactly once', async () => {
    const businessId = await seedBusiness();
    mail.uncertainNext = 1;
    mail.acceptedBeforeUncertain = true;

    const answer = await emails().requestVerification(businessId, EMAIL);

    expect(answer.state).toBe('sent');
    expect(mail.attempts).toBe(2);
    expect(mail.outbox).toHaveLength(1);
    expect(mail.outbox[0]!.idempotencyKey).toMatch(/^billing-email-verify:[0-9a-f]{64}$/);
    expect(await links(businessId)).toEqual([
      { voided: false, outcome: 'accepted', consumed: false },
    ]);
  });

  it('still unknown after the retry: the link stays valid, is counted, and the merchant is told the truth', async () => {
    const businessId = await seedBusiness();
    mail.uncertainNext = 2;
    mail.acceptedBeforeUncertain = true;

    const answer = await emails().requestVerification(businessId, EMAIL);

    expect(answer).toMatchObject({ state: 'delivery_uncertain', retryAfterSeconds: 60 });
    expect(mail.attempts).toBe(2);
    expect(await links(businessId)).toEqual([
      { voided: false, outcome: 'uncertain', consumed: false },
    ]);
    /* It counts against the cooldown, so a double click cannot mail a second link. */
    expect((await emails().requestVerification(businessId, undefined)).state).toBe('rate_limited');
    /* The status says what is known and what is not. */
    const status = await emails().status(businessId);
    expect(status.outstandingLink).toMatchObject({ delivery: 'uncertain' });
  });

  it('a link whose response was lost still proves the mailbox when it arrives', async () => {
    const businessId = await seedBusiness();
    mail.uncertainNext = 2;
    mail.acceptedBeforeUncertain = true;
    expect((await emails().requestVerification(businessId, EMAIL)).state).toBe(
      'delivery_uncertain',
    );

    /* The provider had taken it after all: the merchant opens the mail. */
    expect(mail.outbox).toHaveLength(1);
    const confirmed = await emails().confirm(businessId, tokenFrom(mail.outbox[0]!));

    expect(confirmed.state).toBe('verified');
    expect((await emails().status(businessId)).outstandingLink).toBeNull();
  });

  it('does not mail a second copy: a later request after the cooldown issues one new link, bounded by the hour', async () => {
    const businessId = await seedBusiness();
    mail.uncertainNext = 2;
    expect((await emails().requestVerification(businessId, EMAIL)).state).toBe(
      'delivery_uncertain',
    );
    expect(mail.outbox).toHaveLength(0);
    await age(businessId, 61);

    expect((await emails().requestVerification(businessId, undefined)).state).toBe('sent');
    expect(mail.outbox).toHaveLength(1);
    /* Both attempts count toward the five an hour. */
    const counted = await sql1<{ n: number }>(
      businessId,
      sql`SELECT count(*)::int AS n FROM billing_email_verifications
          WHERE business_id = ${businessId}::uuid AND voided_at IS NULL`,
    );
    expect(counted[0]!.n).toBe(2);
  });

  it('a definite refusal on the retry is not proof that nothing was mailed', async () => {
    const businessId = await seedBusiness();
    const flaky = new MockEmailSender();
    let calls = 0;
    flaky.send = async () => {
      calls += 1;
      if (calls === 1) throw new EmailDeliveryUncertainError('lost');
      throw new Error('resend send failed with 422');
    };

    const answer = await emails(flaky).requestVerification(businessId, EMAIL);

    expect(answer.state).toBe('delivery_uncertain');
    expect(await links(businessId)).toEqual([
      { voided: false, outcome: 'uncertain', consumed: false },
    ]);
  });

  it('a definite refusal on the first attempt still voids the link and gives the allowance back', async () => {
    const businessId = await seedBusiness();
    mail.failNext = true;

    expect(await emails().requestVerification(businessId, EMAIL)).toEqual({
      state: 'unavailable',
      reason: 'send_failed',
    });
    expect(mail.attempts).toBe(1);
    expect((await links(businessId))[0]).toMatchObject({ voided: true });
  });

  it('a suppressed address is refused outright, never called uncertain', async () => {
    const businessId = await seedBusiness();
    const suppressed: EmailSender = {
      available: true,
      send: async () => {
        throw new EmailSuppressedError();
      },
    };

    expect(
      await emails(suppressed as MockEmailSender).requestVerification(businessId, EMAIL),
    ).toEqual({
      state: 'unavailable',
      reason: 'address_unusable',
    });
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

/**
 * OWN-58: the per-business limits alone let one person mail a stranger's inbox from many trial
 * businesses. The same five-an-hour and sixty-second limits therefore also hold per ADDRESS, across
 * every business, decided under a lock so concurrent requests cannot slip past, and refused with the
 * same generic answer as a business's own limit so nothing about another tenant leaks.
 */
describe('rate limits per address, across businesses (OWN-58)', () => {
  it('refuses a second business mailing the same address within the cooldown, generically', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    await mailed(a, EMAIL);
    const refused = await emails().requestVerification(b, EMAIL);
    expect(Object.keys(refused).sort()).toEqual(['retryAfterSeconds', 'state']);
    expect(refused.state).toBe('rate_limited');
    if (refused.state === 'rate_limited') {
      expect(refused.retryAfterSeconds).toBeGreaterThan(0);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
    expect(mail.outbox).toHaveLength(1);
    /* The refused request cost the second business nothing: no link was recorded for it. */
    const rows = await sql1<{ n: number }>(
      b,
      sql`SELECT count(*)::int AS n FROM billing_email_verifications WHERE business_id = ${b}::uuid`,
    );
    expect(rows[0]!.n).toBe(0);
    /* Another address is not held back by this one. */
    expect((await emails().requestVerification(b, OTHER)).state).toBe('sent');
  });

  it('allows five links an hour to one address however many businesses ask', async () => {
    for (let i = 0; i < 5; i += 1) {
      const business = await seedBusiness();
      expect((await emails().requestVerification(business, EMAIL)).state).toBe('sent');
      await ageAddressCounter(61);
    }
    const sixth = await seedBusiness();
    expect(await emails().requestVerification(sixth, EMAIL)).toEqual({
      state: 'rate_limited',
      retryAfterSeconds: 60 * 60,
    });
    expect(mail.outbox).toHaveLength(5);
  });

  it('compares the address the way the mailbox does: case and spaces do not make a new address', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    await mailed(a, EMAIL);
    expect((await emails().requestVerification(b, '  ADA@Shop.Example.NG ')).state).toBe(
      'rate_limited',
    );
  });

  it('issues exactly one link when ten businesses ask for one address at the same moment', async () => {
    const businesses = await Promise.all(Array.from({ length: 10 }, () => seedBusiness()));
    const answers = await Promise.all(
      businesses.map((business) => emails().requestVerification(business, EMAIL)),
    );
    expect(answers.filter((a) => a.state === 'sent')).toHaveLength(1);
    expect(answers.filter((a) => a.state === 'rate_limited')).toHaveLength(9);
    expect(mail.outbox).toHaveLength(1);
  });

  it('issues exactly one link when one business sends ten requests at once from separate sessions', async () => {
    const business = await seedBusiness();
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => emails().requestVerification(business, EMAIL)),
    );
    expect(answers.filter((a) => a.state === 'sent')).toHaveLength(1);
    expect(mail.outbox).toHaveLength(1);
  });

  it('does not count a link that could not be mailed against the address', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    mail.failNext = true;
    expect((await emails().requestVerification(a, EMAIL)).state).toBe('unavailable');
    expect((await emails().requestVerification(b, EMAIL)).state).toBe('sent');
  });

  it('keeps only hashes: no address and no business in the shared counter', async () => {
    const a = await seedBusiness();
    await mailed(a, EMAIL);
    const { db: owner, close } = createDb(urls.owner, { max: 1 });
    try {
      const columns = await owner.execute<{ column_name: string }>(
        sql`SELECT column_name FROM information_schema.columns
            WHERE table_name = 'billing_email_address_requests' ORDER BY 1`,
      );
      expect([...columns].map((c) => c.column_name)).toEqual([
        'address_hash',
        'created_at',
        'token_hash',
        'voided_at',
      ]);
      const rows = await owner.execute<{ address_hash: string }>(
        sql`SELECT address_hash FROM billing_email_address_requests`,
      );
      expect([...rows].map((r) => r.address_hash)).toEqual([
        createHash('sha256').update(EMAIL).digest('hex'),
      ]);
    } finally {
      await close();
    }
  });

  it('lets the app role count and record but not rewrite or delete, and gives the worker nothing', async () => {
    const businessId = await seedBusiness();
    const rows = await sql1<Record<string, boolean>>(
      businessId,
      sql`SELECT
            has_table_privilege('rekoda_app', 'billing_email_address_requests', 'SELECT') AS app_select,
            has_table_privilege('rekoda_app', 'billing_email_address_requests', 'INSERT') AS app_insert,
            has_table_privilege('rekoda_app', 'billing_email_address_requests', 'DELETE') AS app_delete,
            has_column_privilege('rekoda_app', 'billing_email_address_requests', 'created_at', 'UPDATE') AS app_rewrite,
            has_column_privilege('rekoda_app', 'billing_email_address_requests', 'voided_at', 'UPDATE') AS app_void,
            has_table_privilege('rekoda_worker', 'billing_email_address_requests',
                                'SELECT,INSERT,UPDATE,DELETE') AS worker`,
    );
    expect(rows[0]).toEqual({
      app_select: true,
      app_insert: true,
      app_delete: false,
      app_rewrite: false,
      app_void: true,
      worker: false,
    });
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
