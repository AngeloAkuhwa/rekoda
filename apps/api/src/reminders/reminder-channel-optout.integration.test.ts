/**
 * REM-03 / OWN-69: customer opt-outs are per channel.
 *
 * The owner's ruling (2 Nov 2026): an email unsubscribe stops automated reminder email for that
 * merchant and that address only; a WhatsApp STOP stops WhatsApp only; neither touches the other,
 * and each is scoped to one merchant. These tests drive the real reminder service through the real
 * WhatsApp gateway (`WabaTemplateService`, where STOP is enforced), against the real database under
 * RLS. Only the two providers are doubles (Meta's sender and the email sender).
 *
 * The last block proves the dispatch-time recheck: an opt-out that commits after the attempt was
 * opened (its `sending` row written) but before the provider is called still stops the message.
 * That is the point every later dispatcher, including scheduled and bulk reminders (REM-05), goes
 * through, because they send through `ReminderService.sendOne`.
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
  remindersRepo,
  sql,
  wabaRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { loadConfig, type ApiConfig } from '../config.js';
import { MockEmailSender } from '../email/email.port.js';
import { StubSender } from '../channels/sender.stub.js';
import { WabaTemplateService } from '../channels/waba-templates.service.js';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { ReminderService } from './reminder.service.js';

let urls: Urls;
let db: Db;
let closeDb: () => Promise<void>;
let config: ApiConfig;
let meta: StubSender;
let mail: MockEmailSender;

const EMAIL = 'ada@customer.example.ng';
const PHONE = '+2348039998888';
const MERCHANT_TOKEN = 'EAAB-merchant-waba-token';

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['CONNECTION_KEY'] = randomBytes(32).toString('hex');
  ({ db, close: closeDb } = createDb(urls.app, { max: 6 }));
  config = { ...loadConfig(), webUrl: 'https://app.rekoda.test', customerReminders: true };
});

afterAll(async () => {
  await closeDb?.();
});

beforeEach(async () => {
  await truncateAll(urls);
  meta = new StubSender();
  mail = new MockEmailSender();
});

const reminders = () =>
  new ReminderService(
    config,
    db,
    mail,
    new WabaTemplateService(db, config, meta, new PrivacyGateway(db, config)),
  );

interface Shop {
  businessId: string;
  userId: string;
  invoiceNumber: string;
  phoneNumberId: string;
}

let seq = 0;
const key = () => `optout-${(seq += 1)}-${randomBytes(4).toString('hex')}`;

/** A merchant on its own WhatsApp number, one customer with both an email and a phone, one unpaid invoice. */
async function shop(name = 'Adaeze Fabrics'): Promise<Shop> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481760${String(seq).padStart(4, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name,
    businessType: null,
    ownerUserId: user.id,
  });
  const businessId = business.id;
  await billingRepo.setPlan(db, { businessId, plan: 'complete', expiresAt: null, actor: 'test' });

  const phoneNumberId = `pn-optout-${seq}`;
  const connected = await withBusiness(db, businessId, (tx) =>
    wabaRepo.connectWaba(tx, {
      businessId,
      wabaId: `waba-optout-${seq}`,
      phoneNumberId,
      accessTokenCipher: encryptFacet(
        MERCHANT_TOKEN,
        config.connectionKey,
        `${businessId}:waba_token`,
      ),
      tokenTail: MERCHANT_TOKEN.slice(-4),
    }),
  );
  if (connected.outcome !== 'connected') throw new Error('fixture: WABA connect failed');
  /* The customer wrote in recently, so a free-form WhatsApp reminder is allowed (24-hour window). */
  await withBusiness(db, businessId, (tx) =>
    wabaRepo.touchServiceWindow(tx, {
      businessId,
      wabaConnectionId: connected.id,
      customerHash: customerHash(businessId, phoneNumberId),
    }),
  );

  const customer = await customersRepo.createCustomerWithIdentities(db, businessId, 'X81', [
    {
      facet: 'email',
      ciphertext: encryptFacet(EMAIL, config.vaultKey, `${businessId}:email`),
      matchKey: null,
    },
    {
      facet: 'phone',
      ciphertext: encryptFacet(PHONE, config.vaultKey, `${businessId}:phone`),
      matchKey: matchKeyFor(businessId, 'phone', PHONE, config.matchKey),
    },
  ]);
  const sale = await withBusiness(db, businessId, (tx) =>
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
      sourceId: `draft-${seq}`,
      actor: 'system',
    }),
  );
  await reminders().setPublicContact(businessId, '08031112222');
  return { businessId, userId: user.id, invoiceNumber: sale.invoiceNumber, phoneNumberId };
}

/** A second customer of the same merchant, reachable by email only, with their own unpaid invoice. */
async function anotherCustomer(s: Shop, email: string): Promise<Shop> {
  seq += 1;
  const customer = await customersRepo.createCustomerWithIdentities(db, s.businessId, 'X82', [
    {
      facet: 'email',
      ciphertext: encryptFacet(email, config.vaultKey, `${s.businessId}:email`),
      matchKey: null,
    },
  ]);
  const sale = await withBusiness(db, s.businessId, (tx) =>
    issueRepo.issueSale(tx, {
      businessId: s.businessId,
      customerId: customer.id,
      customerToken: 'CUSTOMER_X82',
      items: [{ name: 'wrapper', quantity: 1, unitPriceK: 2_000_000 }],
      subtotalK: 2_000_000,
      discountK: 0,
      deliveryFeeK: 0,
      vatK: 0,
      totalK: 2_000_000,
      paidK: 0,
      balanceDueK: 2_000_000,
      method: 'transfer',
      sourceType: 'chat',
      sourceId: `draft-${seq}`,
      actor: 'system',
    }),
  );
  return { ...s, invoiceNumber: sale.invoiceNumber };
}

function customerHash(businessId: string, phoneNumberId: string): string {
  return participantIndexFor(config.matchKey, {
    businessId,
    channelAccountId: phoneNumberId,
    keyVersion: PARTICIPANT_INDEX_KEY_VERSION,
    normalisedParticipant: PHONE,
  });
}

/** What the signed email link does: this merchant, this address, email only. */
const unsubscribeEmail = (s: Shop) =>
  withBusiness(db, s.businessId, (tx) =>
    remindersRepo.recordEmailOptOut(tx, s.businessId, emailSuppressionKey(EMAIL)),
  );

/** What the customer's WhatsApp STOP does: this merchant's number, WhatsApp only. */
const stopWhatsApp = (s: Shop) =>
  withBusiness(db, s.businessId, (tx) =>
    customerConsentRepo.setCustomerOptOut(
      tx,
      {
        businessId: s.businessId,
        channelAccountId: s.phoneNumberId,
        customerHash: customerHash(s.businessId, s.phoneNumberId),
        indexKeyVersion: PARTICIPANT_INDEX_KEY_VERSION,
      },
      new Date(),
    ),
  );

const send = async (
  s: Shop,
  channel: 'email' | 'whatsapp',
  service: ReminderService = reminders(),
) => {
  const out = await service.send(s.businessId, s.userId, {
    invoiceNumber: s.invoiceNumber,
    channels: [channel],
    idempotencyKey: key(),
    attest: true,
  });
  return out.results[0]!.reminder;
};

const serviceUnitsUsed = async (s: Shop) => {
  const rows = await withBusiness(db, s.businessId, (tx) =>
    tx.execute<{ used: number }>(
      sql`SELECT used FROM usage_counters WHERE unit = 'SERVICE_MESSAGE'`,
    ),
  );
  return [...rows][0]?.used ?? 0;
};

describe('an email unsubscribe (OWN-69)', () => {
  it('through the real signed link: stops reminder email for that merchant and address, and leaves WhatsApp reminders eligible', async () => {
    const s = await shop();
    expect((await send(s, 'email')).status).toBe('sent');
    const token = /token=([^\s]+)/.exec(mail.outbox[0]!.text)![1]!;
    expect(await reminders().optOut(decodeURIComponent(token))).toBe(true);

    expect(await send(s, 'email')).toMatchObject({
      status: 'blocked',
      reasonCode: 'customer_opted_out',
    });
    expect(mail.outbox).toHaveLength(1);

    expect((await send(s, 'whatsapp')).status).toBe('sent');
    expect(meta.connectionTexts).toHaveLength(1);
    expect(meta.connectionTexts[0]!.to).toBe(PHONE);
  });

  it('covers that address only: another customer of the same merchant, at another address, still gets email', async () => {
    const s = await shop();
    await unsubscribeEmail(s);
    const other = await anotherCustomer(s, 'chidi@customer.example.ng');

    expect((await send(s, 'email')).status).toBe('blocked');
    expect((await send(other, 'email')).status).toBe('sent');
    expect(mail.outbox.map((m) => m.to)).toEqual(['chidi@customer.example.ng']);
  });
});

describe('a WhatsApp STOP (OWN-69)', () => {
  it('stops WhatsApp reminders, spends no unit, and leaves reminder email eligible', async () => {
    const s = await shop();
    await stopWhatsApp(s);

    expect(await send(s, 'whatsapp')).toMatchObject({
      status: 'blocked',
      reasonCode: 'customer_opted_out',
    });
    expect(meta.connectionTexts).toHaveLength(0);
    expect(await serviceUnitsUsed(s)).toBe(0);

    expect((await send(s, 'email')).status).toBe('sent');
    expect(mail.outbox).toHaveLength(1);
    expect(mail.outbox[0]!.to).toBe(EMAIL);
  });
});

describe('one reminder event on both channels', () => {
  it('records each channel on its own preference', async () => {
    const s = await shop();
    await unsubscribeEmail(s);
    const both = await reminders().send(s.businessId, s.userId, {
      invoiceNumber: s.invoiceNumber,
      channels: 'auto',
      idempotencyKey: key(),
      attest: true,
    });
    const by = Object.fromEntries(both.results.map((r) => [r.channel, r.reminder]));
    expect(by['whatsapp']!.status).toBe('sent');
    expect(by['email']).toMatchObject({ status: 'blocked', reasonCode: 'customer_opted_out' });
    expect(mail.outbox).toHaveLength(0);
    expect(meta.connectionTexts).toHaveLength(1);
  });
});

describe('preferences are kept per merchant', () => {
  it("one merchant's email unsubscribe and WhatsApp STOP never silence another merchant", async () => {
    const a = await shop('Alpha Ltd');
    const b = await shop('Beta Ltd');
    await unsubscribeEmail(a);
    await stopWhatsApp(a);

    expect((await send(a, 'email')).status).toBe('blocked');
    expect((await send(a, 'whatsapp')).status).toBe('blocked');

    expect((await send(b, 'email')).status).toBe('sent');
    expect((await send(b, 'whatsapp')).status).toBe('sent');
    expect(mail.outbox.map((m) => m.to)).toEqual([EMAIL]);
    expect(meta.connectionTexts).toHaveLength(1);
  });
});

describe('an opt-out that arrives after the attempt was opened', () => {
  /**
   * Runs `prepare` (which writes the `sending` row and commits), then lets `between` commit an
   * opt-out, then lets dispatch continue: the deterministic form of an unsubscribe landing while a
   * reminder is already on its way to the provider.
   */
  function withOptOutBeforeDispatch(between: () => Promise<unknown>): ReminderService {
    const service = reminders();
    type Preparing = { prepare: (...args: unknown[]) => Promise<unknown> };
    const inner = service as unknown as Preparing;
    const real = inner.prepare.bind(service);
    inner.prepare = async (...args: unknown[]) => {
      const prepared = await real(...args);
      await between();
      return prepared;
    };
    return service;
  }

  it('an email unsubscribe stops the email at dispatch, and the history says why', async () => {
    const s = await shop();
    const reminder = await send(
      s,
      'email',
      withOptOutBeforeDispatch(() => unsubscribeEmail(s)),
    );
    expect(reminder).toMatchObject({ status: 'blocked', reasonCode: 'customer_opted_out' });
    expect(mail.outbox).toHaveLength(0);
  });

  /* This STOP lands before the gateway's own consent read, so the reservation check refuses it;
   * the narrower window after the reservation commits is the next test. */
  it('a WhatsApp STOP stops the WhatsApp message at dispatch and spends no unit', async () => {
    const s = await shop();
    const reminder = await send(
      s,
      'whatsapp',
      withOptOutBeforeDispatch(() => stopWhatsApp(s)),
    );
    expect(reminder).toMatchObject({ status: 'blocked', reasonCode: 'customer_opted_out' });
    expect(meta.connectionTexts).toHaveLength(0);
    expect(await serviceUnitsUsed(s)).toBe(0);
  });

  it('a WhatsApp STOP that commits after the gateway reserved the unit, before Meta is called, still stops the message and refunds the unit', async () => {
    /* The narrower window inside the gateway: its consent read and unit reservation run in one
     * transaction, and the provider is called after that commits. The STOP here commits from
     * another connection while that transaction is still open (after its consent read), so only a
     * re-read after the reservation commits can see it. */
    const s = await shop();
    const gateway = new WabaTemplateService(db, config, meta, new PrivacyGateway(db, config));
    type Reserving = { reserveCustomerText: (...args: unknown[]) => Promise<unknown> };
    const inner = gateway as unknown as Reserving;
    const real = inner.reserveCustomerText.bind(gateway);
    inner.reserveCustomerText = async (...args: unknown[]) => {
      const reserved = await real(...args);
      await stopWhatsApp(s);
      return reserved;
    };
    const service = new ReminderService(config, db, mail, gateway);

    expect(await send(s, 'whatsapp', service)).toMatchObject({
      status: 'blocked',
      reasonCode: 'customer_opted_out',
    });
    expect(meta.connectionTexts).toHaveLength(0);
    expect(await serviceUnitsUsed(s)).toBe(0);
  });

  it("a late opt-out on one channel does not stop the other channel's message", async () => {
    /* Two shops, so the first case's opt-out cannot leak into the second. */
    const s = await shop('Alpha Ltd');
    expect(
      (
        await send(
          s,
          'whatsapp',
          withOptOutBeforeDispatch(() => unsubscribeEmail(s)),
        )
      ).status,
    ).toBe('sent');
    const t = await shop('Beta Ltd');
    expect(
      (
        await send(
          t,
          'email',
          withOptOutBeforeDispatch(() => stopWhatsApp(t)),
        )
      ).status,
    ).toBe('sent');
  });
});

describe('when the dispatch-time opt-out read itself fails', () => {
  /**
   * A database handle whose `n`th transaction rejects. In a one-channel email send the calls are:
   * 1 `prepare` (writes the `sending` row), 2 the dispatch-time opt-out read, 3 `finishReminder`.
   */
  function failingTransaction(...n: number[]): Db {
    let calls = 0;
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return (...args: unknown[]) => {
            calls += 1;
            if (n.includes(calls)) return Promise.reject(new Error('database unavailable'));
            return (target.transaction as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  }

  it('records a definite non-send (failed), never "could not be confirmed", and sends nothing', async () => {
    const s = await shop();
    const service = new ReminderService(
      config,
      failingTransaction(2),
      mail,
      new WabaTemplateService(db, config, meta, new PrivacyGateway(db, config)),
    );
    expect(await send(s, 'email', service)).toMatchObject({
      status: 'failed',
      reasonCode: 'send_failed',
    });
    expect(mail.outbox).toHaveLength(0);
  });

  it('WhatsApp: a failed STOP re-read sends nothing, is a definite failure, and refunds the reserved unit once', async () => {
    /* The gateway's own transactions: 1 reserves the unit and records the outbound, 2 re-reads
     * STOP (reads only), 3 refunds. Nothing left, so spec §4.3 rule 4: the unit comes back. */
    const s = await shop();
    const gateway = new WabaTemplateService(
      failingTransaction(2),
      config,
      meta,
      new PrivacyGateway(db, config),
    );
    expect(await send(s, 'whatsapp', new ReminderService(config, db, mail, gateway))).toMatchObject(
      { status: 'failed', reasonCode: 'send_failed' },
    );
    expect(meta.connectionTexts).toHaveLength(0);
    expect(await serviceUnitsUsed(s)).toBe(0);
  });

  it('WhatsApp: when the refund itself cannot be written either, nothing is sent and the refund is not retried', async () => {
    /* One refund attempt per reservation, never two: a retried decrement after a commit whose
     * acknowledgement was lost would hand out a free unit. The unit then stays spent, the same
     * residual as a process that dies between the reservation and the send. */
    const s = await shop();
    const gateway = new WabaTemplateService(
      failingTransaction(2, 3),
      config,
      meta,
      new PrivacyGateway(db, config),
    );
    expect(await send(s, 'whatsapp', new ReminderService(config, db, mail, gateway))).toMatchObject(
      { status: 'failed', reasonCode: 'send_failed' },
    );
    expect(meta.connectionTexts).toHaveLength(0);
    expect(await serviceUnitsUsed(s)).toBe(1);
  });
});
