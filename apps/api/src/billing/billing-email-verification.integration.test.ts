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
// email-live-payment.integration.test.ts.
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
    // Set, to prove the billing-email confirmation does not pick it up (OD-42(b) is reminders only).
    supportEmail: 'support@rekoda.test',
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
    // OD-42(b) applies to reminder emails only: this confirmation carries no Reply-To.
    expect(mail.outbox[0]!).not.toHaveProperty('replyTo');
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
