/**
 * REM-05: scheduled and bulk payment reminders, end to end against the real database under the
 * application and worker roles, the real reminder service and the real WhatsApp gateway. Only the
 * Meta and email providers are doubles.
 *
 * What is proved: a preview writes and sends nothing and reports each exclusion; confirmation is
 * explicit; a scheduled batch waits for its time; every recipient's eligibility (payment, opt-out,
 * stop) is re-read at its own send; a duplicate invoice is reminded once; cancellation stops what
 * has not been dispatched, including a recipient already claimed whose send had not yet begun; a
 * worker restart never sends twice; repeated provider refusals pause the batch; two overlapping
 * passes send each recipient once; another business can neither see nor touch a batch; discovery
 * is worker-only and ID-only; and a batch writes no ledger, sale or invoice row.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emailSuppressionKey } from '@rekoda/core';
import {
  encryptFacet,
  matchKeyFor,
  participantIndexFor,
  PARTICIPANT_INDEX_KEY_VERSION,
} from '@rekoda/core/vault';
import {
  billingRepo,
  createDb,
  customerConsentRepo,
  customersRepo,
  identity,
  issueRepo,
  reminderBatchesRepo,
  remindersRepo,
  settleRepo,
  sql,
  wabaRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { loadConfig, type ApiConfig } from '../config.js';
import {
  EmailRefusedError,
  MockEmailSender,
  type EmailSender,
  type OutboundEmail,
} from '../email/email.port.js';
import { StubSender } from '../channels/sender.stub.js';
import { WabaTemplateService } from '../channels/waba-templates.service.js';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { ReminderService } from './reminder.service.js';
import {
  BatchKeyReused,
  BatchNotFound,
  BatchRemindersNotReleased,
  BatchScheduleOutOfRange,
  BatchUnknownInvoices,
  REMINDER_BATCH_LIMITS,
  ReminderBatchService,
  sweepReminderBatches,
} from './reminder-batch.service.js';

let urls: Urls;
let db: Db;
let workerDb: Db;
let ownerDb: Db;
const closers: Array<() => Promise<void>> = [];
let config: ApiConfig;
let meta: StubSender;
let mail: MockEmailSender;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['CONNECTION_KEY'] = randomBytes(32).toString('hex');
  for (const [url, set] of [
    [urls.app, (d: Db) => (db = d)],
    [urls.worker, (d: Db) => (workerDb = d)],
    [urls.owner, (d: Db) => (ownerDb = d)],
  ] as const) {
    const made = createDb(url, { max: 6 });
    set(made.db);
    closers.push(made.close);
  }
  config = { ...loadConfig(), webUrl: 'https://app.rekoda.test', customerReminders: true };
});

afterAll(async () => {
  for (const close of closers) await close();
});

beforeEach(async () => {
  await truncateAll(urls);
  meta = new StubSender();
  mail = new MockEmailSender();
});

const reminderService = (email: EmailSender = mail, cfg: ApiConfig = config) =>
  new ReminderService(
    cfg,
    db,
    email,
    new WabaTemplateService(db, cfg, meta, new PrivacyGateway(db, cfg)),
  );
const batches = (reminders: ReminderService = reminderService(), cfg: ApiConfig = config) =>
  new ReminderBatchService(cfg, db, reminders);
const sweep = (reminders: ReminderService = reminderService(), at?: Date) =>
  sweepReminderBatches({ workerDb, appDb: db, reminders }, at);

interface Shop {
  businessId: string;
  ownerId: string;
  invoices: Array<{ number: string; id: string; email: string; phone: string; customerId: string }>;
}

let seq = 0;
const key = () => `batch-key-${(seq += 1)}-${randomBytes(4).toString('hex')}`;

/** A merchant with `n` unpaid invoices, each to its own customer reachable by email. */
async function shop(n: number, name = 'Adaeze Fabrics', withPhone = false): Promise<Shop> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481770${String(seq).padStart(4, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name,
    businessType: null,
    ownerUserId: user.id,
  });
  const businessId = business.id;
  await billingRepo.setPlan(db, { businessId, plan: 'complete', expiresAt: null, actor: 'test' });
  const invoices: Shop['invoices'] = [];
  for (let i = 0; i < n; i += 1) {
    seq += 1;
    const email = `customer${seq}@example.ng`;
    const phone = `+2348039${String(seq).padStart(6, '0')}`;
    const customer = await customersRepo.createCustomerWithIdentities(db, businessId, `X${seq}`, [
      {
        facet: 'email',
        ciphertext: encryptFacet(email, config.vaultKey, `${businessId}:email`),
        matchKey: null,
      },
      ...(withPhone
        ? [
            {
              facet: 'phone' as const,
              ciphertext: encryptFacet(phone, config.vaultKey, `${businessId}:phone`),
              matchKey: matchKeyFor(businessId, 'phone', phone, config.matchKey),
            },
          ]
        : []),
    ]);
    const sale = await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: customer.id,
        customerToken: `CUSTOMER_X${seq}`,
        items: [{ name: 'gown', quantity: 1, unitPriceK: 5_000_000 }],
        subtotalK: 5_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 5_000_000,
        paidK: 0,
        balanceDueK: 5_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: `draft-${seq}`,
        actor: 'system',
      }),
    );
    const found = await withBusiness(db, businessId, (tx) =>
      remindersRepo.invoiceForReminder(tx, businessId, sale.invoiceNumber),
    );
    invoices.push({
      number: sale.invoiceNumber,
      id: found!.invoiceId,
      email,
      phone,
      customerId: customer.id,
    });
  }
  await reminderService().setPublicContact(businessId, '08031112222');
  return { businessId, ownerId: user.id, invoices };
}

const numbers = (s: Shop) => s.invoices.map((i) => i.number);

const confirm = (
  s: Shop,
  extra: Partial<{
    invoiceNumbers: string[];
    scheduledFor: string;
    idempotencyKey: string;
    userId: string;
  }> = {},
  service = batches(),
  now?: Date,
) =>
  service.create(
    s.businessId,
    extra.userId ?? s.ownerId,
    {
      invoiceNumbers: extra.invoiceNumbers ?? numbers(s),
      channels: ['email'],
      idempotencyKey: extra.idempotencyKey ?? key(),
      attest: true,
      confirm: true,
      ...(extra.scheduledFor ? { scheduledFor: extra.scheduledFor } : {}),
    },
    now,
  );

const pay = (s: Shop, invoiceId: string, number: string) =>
  withBusiness(db, s.businessId, (tx) =>
    settleRepo.recordMerchantPayment(tx, {
      businessId: s.businessId,
      invoiceId,
      amountK: 5_000_000,
      method: 'transfer',
      sourceType: 'dashboard',
      sourceId: number,
      actor: 'owner',
    }),
  );

const count = async (s: Shop, table: string) => {
  const rows = await withBusiness(db, s.businessId, (tx) =>
    tx.execute<{ n: string }>(sql.raw(`SELECT count(*)::text AS n FROM ${table}`)),
  );
  return Number([...rows][0]!.n);
};

describe('preview', () => {
  it('reports each recipient and exclusion, de-duplicates, and writes and sends nothing', async () => {
    const s = await shop(3);
    const [a, b, c] = s.invoices;
    await pay(s, b!.id, b!.number);
    await withBusiness(db, s.businessId, (tx) =>
      remindersRepo.recordEmailOptOut(tx, s.businessId, emailSuppressionKey(c!.email)),
    );

    const preview = await batches().preview(s.businessId, {
      invoiceNumbers: [a!.number, b!.number, c!.number, a!.number, 'INV-NOPE'],
      channels: ['email'],
      attest: true,
    });

    expect(preview.duplicates).toEqual([a!.number]);
    expect(preview.eligibleCount).toBe(1);
    expect(preview.excludedCount).toBe(3);
    const by = Object.fromEntries(preview.recipients.map((r) => [r.invoiceNumber, r]));
    expect(by[a!.number]!.channels).toEqual([
      { channel: 'email', eligible: true, reasonCode: null },
    ]);
    expect(by[b!.number]!.channels[0]!.eligible).toBe(false);
    expect(by[c!.number]!.channels[0]).toMatchObject({
      eligible: false,
      reasonCode: 'customer_opted_out',
    });
    expect(by['INV-NOPE']).toMatchObject({ found: false, channels: [] });
    /* Nothing written, nothing sent, and no contact detail in the answer. */
    expect(JSON.stringify(preview)).not.toContain('@example.ng');
    expect(await count(s, 'invoice_reminders')).toBe(0);
    expect(await count(s, 'reminder_attestations')).toBe(0);
    expect(await count(s, 'reminder_batches')).toBe(0);
    expect(mail.attempts).toBe(0);
  });

  it('without the attestation, says email needs it rather than "would send"', async () => {
    const s = await shop(1);
    const preview = await batches().preview(s.businessId, {
      invoiceNumbers: numbers(s),
      channels: ['email'],
    });
    expect(preview.recipients[0]!.channels[0]!.eligible).toBe(false);
    expect(preview.eligibleCount).toBe(0);
  });

  it('for WhatsApp, asks the gateway: no connected WhatsApp number is reported, not promised', async () => {
    const s = await shop(1, 'Adaeze Fabrics', true);
    const preview = await batches().preview(s.businessId, {
      invoiceNumbers: numbers(s),
      channels: ['whatsapp'],
    });
    expect(preview.recipients[0]!.channels).toEqual([
      { channel: 'whatsapp', eligible: false, reasonCode: 'no_whatsapp_connection' },
    ]);
    expect(meta.connectionTexts).toHaveLength(0);
  });
});

describe('confirmation and scheduling', () => {
  it('confirming writes the batch once per distinct invoice and sends nothing until the worker runs', async () => {
    const s = await shop(2);
    const batch = await confirm(s, { invoiceNumbers: [...numbers(s), numbers(s)[0]!] });
    expect(batch).toMatchObject({ state: 'scheduled', itemCount: 2 });
    expect(batch.items.map((i) => i.invoiceNumber)).toEqual(numbers(s));
    expect(mail.attempts).toBe(0);

    const pass = await sweep();
    expect(pass.dispatched).toBe(2);
    expect(mail.outbox.map((m) => m.to).sort()).toEqual(s.invoices.map((i) => i.email).sort());
    const after = await batches().get(s.businessId, batch.id);
    expect(after.state).toBe('completed');
    expect(after.counts).toMatchObject({ sent: 2, pending: 0, notSent: 0 });
    expect(after.items.every((i) => i.reminders[0]?.status === 'sent')).toBe(true);
  });

  it('is idempotent on the key, and refuses the same key for a different list', async () => {
    const s = await shop(2);
    const k = key();
    const first = await confirm(s, { idempotencyKey: k });
    const again = await confirm(s, { idempotencyKey: k });
    expect(again.id).toBe(first.id);
    expect(again.replayed).toBe(true);
    expect(await count(s, 'reminder_batches')).toBe(1);
    await expect(
      confirm(s, { idempotencyKey: k, invoiceNumbers: [numbers(s)[0]!] }),
    ).rejects.toBeInstanceOf(BatchKeyReused);
  });

  it('refuses an unknown invoice number, a time too far ahead, and an unreleased deployment, writing nothing', async () => {
    const s = await shop(1);
    await expect(
      confirm(s, { invoiceNumbers: [numbers(s)[0]!, 'INV-NOPE'] }),
    ).rejects.toBeInstanceOf(BatchUnknownInvoices);
    const tooFar = new Date(Date.now() + REMINDER_BATCH_LIMITS.maxScheduleAheadMs + 60_000);
    await expect(confirm(s, { scheduledFor: tooFar.toISOString() })).rejects.toBeInstanceOf(
      BatchScheduleOutOfRange,
    );
    const off = { ...config, customerReminders: false };
    await expect(confirm(s, {}, batches(reminderService(mail, off), off))).rejects.toBeInstanceOf(
      BatchRemindersNotReleased,
    );
    expect(await count(s, 'reminder_batches')).toBe(0);
  });

  it('a batch scheduled for later waits for its time, then sends', async () => {
    const s = await shop(1);
    const at = new Date(Date.now() + 3_600_000);
    const batch = await confirm(s, { scheduledFor: at.toISOString() });
    expect((await sweep()).dispatched).toBe(0);
    expect(mail.attempts).toBe(0);
    const later = await sweep(reminderService(), new Date(at.getTime() + 1_000));
    expect(later.dispatched).toBe(1);
    expect((await batches().get(s.businessId, batch.id)).counts.sent).toBe(1);
  });
});

describe('eligibility is re-read at each send', () => {
  it('a payment after scheduling stops that recipient; the others still go', async () => {
    const s = await shop(3);
    const batch = await confirm(s);
    await pay(s, s.invoices[1]!.id, s.invoices[1]!.number);
    await sweep();
    const after = await batches().get(s.businessId, batch.id);
    expect(after.counts).toMatchObject({ sent: 2, notSent: 1 });
    expect(after.items[1]!.reminders[0]!.status).toBe('blocked');
    expect(mail.outbox.map((m) => m.to)).not.toContain(s.invoices[1]!.email);
  });

  it('an email opt-out after scheduling stops that recipient on email', async () => {
    const s = await shop(2);
    const batch = await confirm(s);
    await withBusiness(db, s.businessId, (tx) =>
      remindersRepo.recordEmailOptOut(tx, s.businessId, emailSuppressionKey(s.invoices[0]!.email)),
    );
    await sweep();
    const after = await batches().get(s.businessId, batch.id);
    expect(after.items[0]!.reminders[0]).toMatchObject({
      status: 'blocked',
      reasonCode: 'customer_opted_out',
    });
    expect(mail.outbox.map((m) => m.to)).toEqual([s.invoices[1]!.email]);
  });

  it('a scheduler removed from the business before dispatch sends nothing in their name', async () => {
    const s = await shop(1);
    const helper = await identity.upsertUserByPhone(db, '+2348099990001');
    await identity.addMembership(db, s.businessId, helper.id, 'delegate');
    const batch = await confirm(s, { userId: helper.id });
    await withBusiness(ownerDb, s.businessId, (tx) =>
      tx.execute(sql`DELETE FROM memberships WHERE user_id = ${helper.id}`),
    );
    await sweep();
    const after = await batches().get(s.businessId, batch.id);
    expect(after.items[0]).toMatchObject({
      state: 'skipped',
      reasonCode: 'scheduler_not_authorised',
    });
    expect(mail.attempts).toBe(0);
  });
});

describe('cancellation', () => {
  it('stops every recipient not yet dispatched, and a completed batch cannot be cancelled', async () => {
    const s = await shop(3);
    const batch = await confirm(s, { scheduledFor: new Date(Date.now() + 600_000).toISOString() });
    const cancelled = await batches().cancel(s.businessId, s.ownerId, batch.id);
    expect(cancelled).toMatchObject({ outcome: 'cancelled', cancelledCount: 3 });
    expect(cancelled.batch.counts.cancelled).toBe(3);
    await sweep(reminderService(), new Date(Date.now() + 3_600_000));
    expect(mail.attempts).toBe(0);

    const t = await shop(1, 'Beta Ltd');
    const done = await confirm(t);
    await sweep();
    expect((await batches().cancel(t.businessId, t.ownerId, done.id)).outcome).toBe(
      'not_cancellable',
    );
  });

  it('a recipient already claimed whose send has not begun is stopped by a cancellation that commits first', async () => {
    const s = await shop(2);
    const batch = await confirm(s);
    /* Cancel lands between the worker's claim and the reminder's own transaction. */
    const reminders = reminderService();
    type Preparing = { prepare: (...args: unknown[]) => Promise<unknown> };
    const inner = reminders as unknown as Preparing;
    const real = inner.prepare.bind(reminders);
    let first = true;
    inner.prepare = async (...args: unknown[]) => {
      if (first) {
        first = false;
        await batches().cancel(s.businessId, s.ownerId, batch.id);
      }
      return real(...args);
    };
    const pass = await sweep(reminders);
    expect(pass.withdrawn).toBe(1);
    expect(mail.attempts).toBe(0);
    const after = await batches().get(s.businessId, batch.id);
    expect(after.state).toBe('cancelled');
    expect(after.counts).toMatchObject({ cancelled: 2, sent: 0 });
    expect(await count(s, 'invoice_reminders')).toBe(0);
  });
});

describe('failure and retry', () => {
  it('a worker that died mid-send is resumed with the same key: never a second send', async () => {
    const s = await shop(1);
    const batch = await confirm(s);
    /* The first pass sends, then dies before recording the recipient as finished. */
    const reminders = reminderService();
    const realSend = reminders.send.bind(reminders);
    reminders.send = async (...args: Parameters<ReminderService['send']>) => {
      await realSend(...args);
      throw new Error('worker killed');
    };
    const crashed = await sweep(reminders);
    expect(crashed.errored).toBe(1);
    expect(mail.outbox).toHaveLength(1);

    /* Past the stale-claim window a fresh worker reclaims it; the reminder key replays. */
    const later = new Date(Date.now() + REMINDER_BATCH_LIMITS.staleClaimMs + 60_000);
    await sweep(reminderService(), later);
    expect(mail.outbox).toHaveLength(1);
    expect(mail.attempts).toBe(1);
    const after = await batches().get(s.businessId, batch.id);
    expect(after.state).toBe('completed');
    expect(after.counts.sent).toBe(1);
  });

  it('a worker that died before the send, then an opt-out: the retry re-reads it and sends nothing', async () => {
    const s = await shop(1);
    const batch = await confirm(s);
    const reminders = reminderService();
    reminders.send = () => Promise.reject(new Error('worker killed before the send'));
    expect((await sweep(reminders)).errored).toBe(1);
    await withBusiness(db, s.businessId, (tx) =>
      remindersRepo.recordEmailOptOut(tx, s.businessId, emailSuppressionKey(s.invoices[0]!.email)),
    );
    const later = new Date(Date.now() + REMINDER_BATCH_LIMITS.staleClaimMs + 60_000);
    await sweep(reminderService(), later);
    expect(mail.attempts).toBe(0);
    const after = await batches().get(s.businessId, batch.id);
    expect(after.items[0]!.reminders[0]).toMatchObject({
      status: 'blocked',
      reasonCode: 'customer_opted_out',
    });
    expect(after.state).toBe('completed');
  });

  it('a timeout is recorded as uncertain and never resent', async () => {
    const s = await shop(1);
    const batch = await confirm(s);
    mail.uncertainNext = 1;
    mail.acceptedBeforeUncertain = true;
    await sweep();
    await sweep(reminderService(), new Date(Date.now() + REMINDER_BATCH_LIMITS.staleClaimMs * 2));
    expect(mail.attempts).toBe(1);
    const after = await batches().get(s.businessId, batch.id);
    expect(after.counts.uncertain).toBe(1);
    expect(after.items[0]!.reminders[0]!.status).toBe('uncertain');
  });

  it('repeated provider refusals (a rate limit) pause the batch; the rest wait for a later pass', async () => {
    const s = await shop(5);
    const batch = await confirm(s);
    class Refusing extends MockEmailSender {
      override async send(_m: OutboundEmail): Promise<void> {
        this.attempts += 1;
        throw new EmailRefusedError('429 rate limited');
      }
    }
    const refusing = new Refusing();
    const pass = await sweep(reminderService(refusing));
    expect(pass.paused).toBe(1);
    expect(refusing.attempts).toBe(REMINDER_BATCH_LIMITS.failuresBeforePause);
    let after = await batches().get(s.businessId, batch.id);
    expect(after.counts).toMatchObject({ notSent: 3, pending: 2 });
    expect(after.state).toBe('scheduled');

    /* Paused: an immediate pass claims nothing. */
    expect((await sweep()).dispatched).toBe(0);
    /* After the pause the provider has recovered: the remaining two go; the refused three are not
     * retried. */
    await sweep(reminderService(), new Date(Date.now() + REMINDER_BATCH_LIMITS.pauseMs + 60_000));
    after = await batches().get(s.businessId, batch.id);
    expect(after.counts).toMatchObject({ sent: 2, notSent: 3, pending: 0 });
    expect(after.state).toBe('completed');
  });

  it('two overlapping passes send each recipient exactly once', async () => {
    const s = await shop(6);
    const batch = await confirm(s);
    /* Each send takes a moment, so both passes are claiming at the same time. */
    class Slow extends MockEmailSender {
      override async send(m: OutboundEmail): Promise<void> {
        await new Promise((r) => setTimeout(r, 40));
        return super.send(m);
      }
    }
    const slow = new Slow();
    mail = slow;
    const [one, two] = await Promise.all([
      sweep(reminderService(slow)),
      sweep(reminderService(slow)),
    ]);
    expect(one.dispatched).toBeGreaterThan(0);
    expect(two.dispatched).toBeGreaterThan(0);
    expect(one.dispatched + two.dispatched).toBe(6);
    expect(mail.outbox).toHaveLength(6);
    expect(new Set(mail.outbox.map((m) => m.to)).size).toBe(6);
    expect((await batches().get(s.businessId, batch.id)).counts.sent).toBe(6);
  });
});

describe('review fixes', () => {
  it('an outage that only times out (uncertain) also pauses the batch, and nothing is resent', async () => {
    const s = await shop(5);
    const batch = await confirm(s);
    mail.uncertainNext = 10;
    const pass = await sweep();
    expect(pass.paused).toBe(1);
    expect(mail.attempts).toBe(REMINDER_BATCH_LIMITS.failuresBeforePause);
    const after = await batches().get(s.businessId, batch.id);
    expect(after.counts).toMatchObject({ uncertain: 3, pending: 2 });
  });

  it('the email attestation is recorded at confirmation, for the address then on file, by the confirming user', async () => {
    const s = await shop(1);
    const before = new Date();
    await confirm(s);
    const rows = await withBusiness(db, s.businessId, (tx) =>
      tx.execute<{ by: string; at: Date; hash: string }>(
        sql`SELECT attested_by_user_id AS by, attested_at AS at, address_hash AS hash FROM reminder_attestations`,
      ),
    );
    expect([...rows]).toHaveLength(1);
    const [row] = [...rows];
    expect(row!.by).toBe(s.ownerId);
    expect(row!.hash).toBe(emailSuppressionKey(s.invoices[0]!.email));
    expect(new Date(row!.at).getTime()).toBeGreaterThanOrEqual(before.getTime() - 1_000);
    expect(mail.attempts).toBe(0);
  });

  it('an address changed after confirmation is never emailed on the old attestation', async () => {
    const s = await shop(1);
    const batch = await confirm(s);
    const c = s.invoices[0]!;
    await customersRepo.eraseFacet(db, s.businessId, c.customerId, 'email');
    await customersRepo.addIdentityFacet(db, s.businessId, c.customerId, {
      facet: 'email',
      ciphertext: encryptFacet('someone.else@example.ng', config.vaultKey, `${s.businessId}:email`),
      matchKey: null,
    });
    await sweep();
    expect(mail.attempts).toBe(0);
    const after = await batches().get(s.businessId, batch.id);
    expect(after.items[0]!.reminders[0]).toMatchObject({
      status: 'blocked',
      reasonCode: 'attestation_required',
    });
  });

  it('a recipient whose send keeps failing unexpectedly is skipped after the bound and the batch finishes', async () => {
    const s = await shop(1);
    const batch = await confirm(s);
    const broken = reminderService();
    broken.send = () => Promise.reject(new Error('cannot open this contact'));
    let at = Date.now();
    for (let i = 0; i < REMINDER_BATCH_LIMITS.maxAttempts; i += 1) {
      expect((await sweep(broken, new Date(at))).errored).toBe(1);
      at += REMINDER_BATCH_LIMITS.staleClaimMs + 60_000;
    }
    await sweep(broken, new Date(at));
    const after = await batches().get(s.businessId, batch.id);
    expect(after.items[0]).toMatchObject({ state: 'skipped', reasonCode: 'dispatch_error' });
    expect(after.state).toBe('completed');
    expect(mail.attempts).toBe(0);
  });

  it('a worker that died after its "sending" row committed is never resent on reclaim', async () => {
    const s = await shop(1);
    const batch = await confirm(s);
    /* The send gets as far as the reminder's own committed `sending` row, then the process dies. */
    const dying = reminderService();
    type Preparing = { prepare: (...args: unknown[]) => Promise<unknown> };
    const inner = dying as unknown as Preparing;
    const realPrepare = inner.prepare.bind(dying);
    inner.prepare = async (...args: unknown[]) => {
      await realPrepare(...args);
      throw new Error('process died after the sending row');
    };
    expect((await sweep(dying)).errored).toBe(1);
    const later = new Date(Date.now() + REMINDER_BATCH_LIMITS.staleClaimMs + 60_000);
    await sweep(reminderService(), later);
    expect(mail.attempts).toBe(0);
    const after = await batches().get(s.businessId, batch.id);
    expect(['sending', 'uncertain']).toContain(after.items[0]!.reminders[0]!.status);
    expect(after.counts.uncertain).toBe(1);
  });

  it('cancelling stops a recipient a dead worker left claimed with nothing sent', async () => {
    const s = await shop(2);
    const batch = await confirm(s);
    const dead = reminderService();
    dead.send = () => Promise.reject(new Error('worker killed before the send'));
    await sweep(dead);
    const cancelled = await batches().cancel(
      s.businessId,
      s.ownerId,
      batch.id,
      new Date(Date.now() + REMINDER_BATCH_LIMITS.staleClaimMs + 60_000),
    );
    expect(cancelled.cancelledCount).toBe(2);
    const after = await batches().get(s.businessId, batch.id);
    expect(after.items.map((i) => i.state)).toEqual(['cancelled', 'cancelled']);
  });

  it('the same key with different channels or attestation is refused, not replayed', async () => {
    const s = await shop(1);
    const k = key();
    await confirm(s, { idempotencyKey: k });
    await expect(
      batches().create(s.businessId, s.ownerId, {
        invoiceNumbers: numbers(s),
        channels: ['whatsapp'],
        idempotencyKey: k,
        attest: true,
        confirm: true,
      }),
    ).rejects.toBeInstanceOf(BatchKeyReused);
  });

  it('a WhatsApp STOP after scheduling stops that recipient on WhatsApp and spends no unit', async () => {
    const s = await shop(2, 'Adaeze Fabrics', true);
    const phoneNumberId = 'pn-batch-1';
    const token = 'EAAB-merchant-waba-token';
    const connected = await withBusiness(db, s.businessId, (tx) =>
      wabaRepo.connectWaba(tx, {
        businessId: s.businessId,
        wabaId: 'waba-batch-1',
        phoneNumberId,
        accessTokenCipher: encryptFacet(token, config.connectionKey, `${s.businessId}:waba_token`),
        tokenTail: token.slice(-4),
      }),
    );
    if (connected.outcome !== 'connected') throw new Error('fixture: WABA connect failed');
    const hashOf = (phone: string) =>
      participantIndexFor(config.matchKey, {
        businessId: s.businessId,
        channelAccountId: phoneNumberId,
        keyVersion: PARTICIPANT_INDEX_KEY_VERSION,
        normalisedParticipant: phone,
      });
    for (const inv of s.invoices) {
      await withBusiness(db, s.businessId, (tx) =>
        wabaRepo.touchServiceWindow(tx, {
          businessId: s.businessId,
          wabaConnectionId: connected.id,
          customerHash: hashOf(inv.phone),
        }),
      );
    }
    const batch = await batches().create(s.businessId, s.ownerId, {
      invoiceNumbers: numbers(s),
      channels: ['whatsapp'],
      idempotencyKey: key(),
      confirm: true,
    });
    await withBusiness(db, s.businessId, (tx) =>
      customerConsentRepo.setCustomerOptOut(
        tx,
        {
          businessId: s.businessId,
          channelAccountId: phoneNumberId,
          customerHash: hashOf(s.invoices[0]!.phone),
          indexKeyVersion: PARTICIPANT_INDEX_KEY_VERSION,
        },
        new Date(),
      ),
    );
    await sweep();
    const after = await batches().get(s.businessId, batch.id);
    expect(after.items[0]!.reminders[0]).toMatchObject({
      status: 'blocked',
      reasonCode: 'customer_opted_out',
    });
    expect(after.items[1]!.reminders[0]!.status).toBe('sent');
    expect(meta.connectionTexts.map((t) => t.to)).toEqual([s.invoices[1]!.phone]);
    const used = await withBusiness(db, s.businessId, (tx) =>
      tx.execute<{ used: number }>(
        sql`SELECT used FROM usage_counters WHERE unit = 'SERVICE_MESSAGE'`,
      ),
    );
    expect([...used][0]?.used ?? 0).toBe(1);
  });

  it('confirms invoice numbers in any letter case, as the preview reads them, and keeps one per invoice', async () => {
    const s = await shop(1);
    const n = numbers(s)[0]!;
    const preview = await batches().preview(s.businessId, {
      invoiceNumbers: [n.toLowerCase(), n],
      channels: ['email'],
      attest: true,
    });
    expect(preview.recipients).toHaveLength(1);
    expect(preview.recipients[0]!.invoiceNumber).toBe(n);
    expect(preview.duplicates).toEqual([n]);
    /* The other order too: the duplicate is still reported in the stored form. */
    const reversed = await batches().preview(s.businessId, {
      invoiceNumbers: [n, n.toLowerCase()],
      channels: ['email'],
      attest: true,
    });
    expect(reversed.recipients.map((r) => r.invoiceNumber)).toEqual([n]);
    expect(reversed.duplicates).toEqual([n]);
    const batch = await confirm(s, { invoiceNumbers: [n.toLowerCase(), n] });
    expect(batch.itemCount).toBe(1);
    expect(batch.items.map((i) => i.invoiceNumber)).toEqual([n]);
  });

  it('the preview flags an invoice already waiting in another scheduled batch (no cooldown is imposed, OWN-67)', async () => {
    const s = await shop(2);
    await confirm(s, {
      invoiceNumbers: [numbers(s)[0]!],
      scheduledFor: new Date(Date.now() + 600_000).toISOString(),
    });
    const preview = await batches().preview(s.businessId, {
      invoiceNumbers: numbers(s),
      channels: ['email'],
      attest: true,
    });
    expect(preview.recipients.map((r) => r.alsoScheduled)).toEqual([true, false]);
    expect(preview.eligibleCount).toBe(2);
    /* Once that batch is cancelled the invoice is no longer waiting anywhere. */
    const waiting = (await batches().list(s.businessId)).batches[0]!;
    await batches().cancel(s.businessId, s.ownerId, waiting.id);
    const after = await batches().preview(s.businessId, {
      invoiceNumbers: numbers(s),
      channels: ['email'],
      attest: true,
    });
    expect(after.recipients.map((r) => r.alsoScheduled)).toEqual([false, false]);
    /* Another business's batch never shows here. */
    const other = await shop(1, 'Beta Ltd');
    const theirs = await batches().preview(other.businessId, {
      invoiceNumbers: numbers(other),
      channels: ['email'],
      attest: true,
    });
    expect(theirs.recipients[0]!.alsoScheduled).toBe(false);
  });

  it('discovery returns the earliest-scheduled batch first', async () => {
    const s = await shop(2);
    const later = await confirm(s, {
      invoiceNumbers: [numbers(s)[0]!],
      scheduledFor: new Date(Date.now() + 120_000).toISOString(),
    });
    const sooner = await confirm(s, {
      invoiceNumbers: [numbers(s)[1]!],
      scheduledFor: new Date(Date.now() + 60_000).toISOString(),
    });
    const due = await reminderBatchesRepo.dueBatches(
      workerDb,
      new Date(Date.now() + 600_000),
      10,
      null,
    );
    expect(due.map((d) => d.batchId)).toEqual([sooner.id, later.id]);
  });
});

describe('tenancy and discovery', () => {
  it('another business can neither read nor cancel a batch, and its rows are invisible to it', async () => {
    const a = await shop(2, 'Alpha Ltd');
    const b = await shop(1, 'Beta Ltd');
    const batch = await confirm(a);
    await expect(batches().get(b.businessId, batch.id)).rejects.toBeInstanceOf(BatchNotFound);
    await expect(batches().cancel(b.businessId, b.ownerId, batch.id)).rejects.toBeInstanceOf(
      BatchNotFound,
    );
    expect((await batches().list(b.businessId)).batches).toHaveLength(0);
    expect(await count(b, 'reminder_batches')).toBe(0);
    expect(await count(b, 'reminder_batch_items')).toBe(0);
    /* Numbers are per business: Alpha's second invoice has no counterpart at Beta, so it cannot
     * be put in Beta's batch (and Beta's own first invoice is Beta's, never Alpha's). */
    await expect(confirm(b, { invoiceNumbers: [numbers(a)[1]!] })).rejects.toBeInstanceOf(
      BatchUnknownInvoices,
    );
    expect((await batches().get(a.businessId, batch.id)).state).toBe('scheduled');
  });

  it('discovery is worker-only and returns ids and the time only', async () => {
    const s = await shop(1);
    const batch = await confirm(s);
    const due = await reminderBatchesRepo.dueBatches(
      workerDb,
      new Date(Date.now() + 1_000),
      10,
      null,
    );
    expect(due).toEqual([
      { batchId: batch.id, businessId: s.businessId, scheduledFor: new Date(batch.scheduledFor) },
    ]);
    const columns = await ownerDb.execute<{ name: string }>(sql`
      SELECT unnest(proargnames[array_length(proargtypes, 1) + 1:]) AS name
      FROM pg_proc WHERE proname = 'sweep_due_reminder_batches'`);
    expect([...columns].map((c) => c.name)).toEqual(['id', 'business_id', 'scheduled_for']);
    const denied = (p: Promise<unknown>) =>
      p.then(
        () => 'allowed',
        (e: { cause?: { message?: string } }) => e.cause?.message ?? String(e),
      );
    expect(
      await denied(
        db.execute(sql`SELECT * FROM sweep_due_reminder_batches(now(), 10, NULL, NULL)`),
      ),
    ).toMatch(/permission denied/);
    expect(await denied(workerDb.execute(sql`SELECT * FROM reminder_batches`))).toMatch(
      /permission denied/,
    );
  });

  it('a batch writes no sale, invoice, payment or ledger row', async () => {
    const s = await shop(2);
    const before = {
      invoices: await count(s, 'invoices'),
      entries: await count(s, 'ledger_entries'),
      payments: await count(s, 'payments'),
    };
    await confirm(s);
    await sweep();
    expect({
      invoices: await count(s, 'invoices'),
      entries: await count(s, 'ledger_entries'),
      payments: await count(s, 'payments'),
    }).toEqual(before);
  });
});
