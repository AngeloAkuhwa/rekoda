/**
 * Template sends metered at send time (spec §24, §4.2/§4.3; PR-060).
 *
 * The claims here are the four ordering rules with real rows behind them:
 * entitlement refuses before the meter moves, the registry refuses before a
 * unit is spent on a send Meta would bounce, the unit is DERIVED from the
 * category and destination at send time, and the one consumption that
 * precedes dispatch comes back on the path that does not deliver.
 */
import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  billingRepo,
  usageRepo,
  conversationsRepo,
  createDb,
  customerConsentRepo,
  identity,
  sql,
  wabaRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { usagePeriod } from '@rekoda/core';
import {
  encryptFacet,
  participantIndexFor,
  PARTICIPANT_INDEX_KEY_VERSION,
} from '@rekoda/core/vault';
import { SendFailed } from './sender.js';
import { StubSender } from './sender.stub.js';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { WabaTemplateService } from './waba-templates.service.js';
import { meterAllowance } from '../billing/plan-terms.js';
import { loadConfig, type ApiConfig } from '../config.js';

let urls: Urls;
let db: Db;
let closeDb: () => Promise<void>;
let config: ApiConfig;
let sender: StubSender;
let service: WabaTemplateService;

const MERCHANT_TOKEN = 'EAAB-merchant-waba-token';

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = 'test-pepper-at-least-32-characters-long';
  process.env['REKODA_API_SECRET'] = 'test-secret-at-least-32-characters-long';
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['CONNECTION_KEY'] = randomBytes(32).toString('hex');

  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));
  config = loadConfig();
  sender = new StubSender();
  service = new WabaTemplateService(db, config, sender, new PrivacyGateway(db, config));
});

afterAll(async () => {
  await closeDb?.();
});

beforeEach(async () => {
  await truncateAll(urls);
  sender.reset();
});

let seq = 0;
async function seedMerchant(plan: 'integrate' | 'complete' | 'chat' = 'integrate') {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481870${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  await billingRepo.setPlan(db, {
    businessId: business.id,
    plan,
    expiresAt: null,
    actor: 'operator:test',
  });
  const phoneNumberId = `pn-tpl-${seq}`;
  const connected = await withBusiness(db, business.id, (tx) =>
    wabaRepo.connectWaba(tx, {
      businessId: business.id,
      wabaId: `waba-tpl-${seq}`,
      phoneNumberId,
      accessTokenCipher: encryptFacet(
        MERCHANT_TOKEN,
        config.connectionKey,
        `${business.id}:waba_token`,
      ),
      tokenTail: MERCHANT_TOKEN.slice(-4),
    }),
  );
  if (connected.outcome !== 'connected') throw new Error('fixture: signup failed');
  return { businessId: business.id, connectionId: connected.id, phoneNumberId };
}

async function registerTemplate(
  businessId: string,
  connectionId: string,
  name: string,
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION',
  approve = true,
) {
  const template = await withBusiness(db, businessId, (tx) =>
    wabaRepo.upsertTemplate(tx, { businessId, wabaConnectionId: connectionId, name, category }),
  );
  if (approve) {
    await withBusiness(db, businessId, (tx) =>
      wabaRepo.markTemplateStatus(tx, { businessId, templateId: template.id, status: 'APPROVED' }),
    );
  }
  return template;
}

async function used(businessId: string, unit: string): Promise<number> {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ used: number }>(
      sql`SELECT used FROM usage_counters WHERE business_id = ${businessId}::uuid AND unit = ${unit}`,
    ),
  );
  return [...rows][0]?.used ?? 0;
}

describe('sending a template on the merchant WABA (§4.2, §4.3)', () => {
  it('an approved utility template sends on the MERCHANT number and meters UTILITY_TEMPLATE', async () => {
    const { businessId, connectionId, phoneNumberId } = await seedMerchant('integrate');
    await registerTemplate(businessId, connectionId, 'payment_reminder', 'UTILITY');

    const outcome = await service.sendTemplate(businessId, {
      to: '+2349098887777',
      name: 'payment_reminder',
      parameters: ['Ada', 'INV-2026-000001'],
    });

    expect(outcome).toEqual({ outcome: 'sent', unit: 'UTILITY_TEMPLATE' });
    expect(await used(businessId, 'UTILITY_TEMPLATE')).toBe(1);
    expect(sender.templates).toHaveLength(1);
    expect(sender.templates[0]).toMatchObject({
      to: '+2349098887777',
      phoneNumberId,
      accessToken: MERCHANT_TOKEN,
      name: 'payment_reminder',
      language: 'en',
      parameters: ['Ada', 'INV-2026-000001'],
    });

    /* Recorded on the CUSTOMER'S OWN thread (F.2), as the template's NAME:
     * the rendered parameters can carry a customer's name, and the
     * conversation history must not. */
    const thread = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.messagesForThread(tx, {
        kind: 'CUSTOMER',
        businessId,
        channel: 'meta',
        channelAccountId: phoneNumberId,
        participantBlindIndex: participantIndexFor(config.matchKey, {
          businessId,
          channelAccountId: phoneNumberId,
          keyVersion: PARTICIPANT_INDEX_KEY_VERSION,
          normalisedParticipant: '+2349098887777',
        }),
        participantIndexKeyVersion: PARTICIPANT_INDEX_KEY_VERSION,
      }),
    );
    expect(thread).toHaveLength(1);
    expect(thread[0]!.body).toBe('[template payment_reminder]');
    expect(thread[0]!.body).not.toContain('Ada');
  });

  it('marketing meters MARKETING_TEMPLATE, and V1 sells none on any plan (pricing-model)', async () => {
    const { businessId, connectionId } = await seedMerchant('complete');
    await registerTemplate(businessId, connectionId, 'new_stock', 'MARKETING');

    const outcome = await service.sendTemplate(businessId, {
      to: '+2349098887777',
      name: 'new_stock',
    });

    expect(outcome).toEqual({ outcome: 'allowance_exhausted', unit: 'MARKETING_TEMPLATE' });
    /* Rule 4: the refusal consumed nothing and dispatched nothing. */
    expect(sender.templates).toHaveLength(0);
    expect(await used(businessId, 'MARKETING_TEMPLATE')).toBe(0);
  });

  it('an authentication template splits its unit by DESTINATION (§4.2)', async () => {
    const { businessId, connectionId } = await seedMerchant('integrate');
    await registerTemplate(businessId, connectionId, 'login_code', 'AUTHENTICATION');

    const lagos = await service.sendTemplate(businessId, {
      to: '+2349098887777',
      name: 'login_code',
    });
    const london = await service.sendTemplate(businessId, {
      to: '+447700900123',
      name: 'login_code',
    });

    /* Neither is sold on this plan — the refusals PIN the derivation: the
     * same template, two destinations, two different units. */
    expect(lagos).toEqual({ outcome: 'allowance_exhausted', unit: 'AUTH_TEMPLATE' });
    expect(london).toEqual({ outcome: 'allowance_exhausted', unit: 'AUTH_INTL_TEMPLATE' });
  });

  it('an unapproved template is refused before anything is spent', async () => {
    const { businessId, connectionId } = await seedMerchant('integrate');
    await registerTemplate(businessId, connectionId, 'payment_reminder', 'UTILITY', false);

    const outcome = await service.sendTemplate(businessId, {
      to: '+2349098887777',
      name: 'payment_reminder',
    });

    expect(outcome).toEqual({ outcome: 'template_not_approved' });
    expect(sender.templates).toHaveLength(0);
    expect(await used(businessId, 'UTILITY_TEMPLATE')).toBe(0);
    const heard = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.messagesFor(tx, businessId),
    );
    expect(heard).toHaveLength(0);
  });

  it('entitlement before meter: a chat plan holds utility capacity it cannot spend HERE', async () => {
    /* Chat sells 25 utility reminders — through Rekoda's own number, a
     * feature that is not this one. Sending on a merchant WABA is
     * Integrate's capability, and the refusal happens BEFORE the meter:
     * the allowance being positive changes nothing (§4.3 rule 1). */
    const { businessId, connectionId } = await seedMerchant('chat');
    await registerTemplate(businessId, connectionId, 'payment_reminder', 'UTILITY');

    const outcome = await service.sendTemplate(businessId, {
      to: '+2349098887777',
      name: 'payment_reminder',
    });

    expect(outcome).toEqual({ outcome: 'not_entitled' });
    expect(sender.templates).toHaveLength(0);
    expect(await used(businessId, 'UTILITY_TEMPLATE')).toBe(0);
  });

  it('a send failure refunds the unit and leaves the debt visible (§4.3 rule 4)', async () => {
    const { businessId, connectionId } = await seedMerchant('integrate');
    await registerTemplate(businessId, connectionId, 'payment_reminder', 'UTILITY');
    sender.failWith(new SendFailed('meta outage'));

    const outcome = await service.sendTemplate(businessId, {
      to: '+2349098887777',
      name: 'payment_reminder',
    });

    expect(outcome).toEqual({ outcome: 'send_failed', unit: 'UTILITY_TEMPLATE' });
    expect(await used(businessId, 'UTILITY_TEMPLATE')).toBe(0);
    /* The recorded message kept its empty provider id: a reply owed and
     * not delivered, findable as such. */
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ provider_message_id: string | null }>(
        sql`SELECT provider_message_id FROM conversation_messages
            WHERE business_id = ${businessId}::uuid AND direction = 'outbound'`,
      ),
    );
    expect([...rows]).toEqual([{ provider_message_id: null }]);
  });
});

describe('the window selects the send (§24; PR-061)', () => {
  async function openWindowFor(businessId: string, connectionId: string, phoneNumberId: string) {
    /* What a customer message does (the customer-message handler calls
     * exactly this): the window's key is the same F.4-scoped blind index
     * the thread routes by. */
    const hash = participantIndexFor(config.matchKey, {
      businessId,
      channelAccountId: phoneNumberId,
      keyVersion: PARTICIPANT_INDEX_KEY_VERSION,
      normalisedParticipant: '+2349098887777',
    });
    await withBusiness(db, businessId, (tx) =>
      wabaRepo.touchServiceWindow(tx, {
        businessId,
        wabaConnectionId: connectionId,
        customerHash: hash,
      }),
    );
  }

  it('outside the window, free-form is refused BEFORE any meter: a template is the way', async () => {
    const { businessId } = await seedMerchant('integrate');

    const outcome = await service.sendCustomerText(businessId, {
      to: '+2349098887777',
      text: 'Your order is ready for pickup',
    });

    expect(outcome).toEqual({ outcome: 'window_closed' });
    expect(sender.connectionTexts).toHaveLength(0);
    expect(await used(businessId, 'SERVICE_MESSAGE')).toBe(0);
  });

  it('inside the window, free-form goes as a SERVICE_MESSAGE, metered and tokenised', async () => {
    const { businessId, connectionId, phoneNumberId } = await seedMerchant('integrate');
    await openWindowFor(businessId, connectionId, phoneNumberId);
    /* Integrate sells 5,000 SERVICE_MESSAGE (PR-117), so the send has room
     * from the plan alone. The bonus credit stays because it proves the
     * other half of the ceiling: a top-up adds to the plan rather than
     * replacing it. */
    const period = usagePeriod(new Date());
    await withBusiness(db, businessId, (tx) =>
      usageRepo.creditBonus(tx, businessId, period, 'SERVICE_MESSAGE', 5),
    );

    const outcome = await service.sendCustomerText(businessId, {
      to: '+2349098887777',
      text: 'Your order is ready for pickup, Ada',
    });

    expect(outcome).toEqual({ outcome: 'sent', unit: 'SERVICE_MESSAGE' });
    expect(await used(businessId, 'SERVICE_MESSAGE')).toBe(1);
    expect(sender.connectionTexts).toHaveLength(1);
    expect(sender.connectionTexts[0]).toMatchObject({
      to: '+2349098887777',
      phoneNumberId,
      accessToken: MERCHANT_TOKEN,
      text: 'Your order is ready for pickup, Ada',
    });
  });

  it('with the window open and the month spent, exhausted means refused (§4.3 rule 4)', async () => {
    const { businessId, connectionId, phoneNumberId } = await seedMerchant('complete');
    await openWindowFor(businessId, connectionId, phoneNumberId);

    /* Spend the month. Before PR-117 this test needed no setup, because
     * SERVICE_MESSAGE was sold on no plan and zero was the starting state;
     * now Complete sells 5,000, so the state worth pinning is the one a
     * real merchant reaches. The window being open does not create
     * capacity, which is what §4.3 rule 4 says and what this proves. */
    const sold = await withBusiness(db, businessId, (tx) =>
      meterAllowance({ planCatalogueReads: true }, tx, businessId, 'complete', 'SERVICE_MESSAGE'),
    );
    expect(sold).toBeGreaterThan(0);
    await withBusiness(db, businessId, (tx) =>
      usageRepo.consumeUnit(tx, businessId, usagePeriod(new Date()), 'SERVICE_MESSAGE', sold, sold),
    );

    const outcome = await service.sendCustomerText(businessId, {
      to: '+2349098887777',
      text: 'hello',
    });

    expect(outcome).toEqual({ outcome: 'allowance_exhausted', unit: 'SERVICE_MESSAGE' });
    expect(sender.connectionTexts).toHaveLength(0);
    /* The refusal consumed nothing: the counter still reads exactly what
     * was spent before it, not one more. */
    expect(await used(businessId, 'SERVICE_MESSAGE')).toBe(sold);
  });
});

describe('the sends are the health check (§24; PR-062)', () => {
  it('a failed send marks the connection UNHEALTHY with WHY; the next success recovers it', async () => {
    const { businessId, connectionId } = await seedMerchant('integrate');
    await registerTemplate(businessId, connectionId, 'payment_reminder', 'UTILITY');

    sender.failWith(new SendFailed('meta /pn/messages failed with 401'));
    await service.sendTemplate(businessId, { to: '+2349098887777', name: 'payment_reminder' });

    let row = await withBusiness(db, businessId, (tx) =>
      wabaRepo.wabaConnectionFor(tx, businessId),
    );
    expect(row!.status).toBe('UNHEALTHY');
    expect(row!.healthReason).toBe('meta /pn/messages failed with 401');

    /* UNHEALTHY still sends — the send is how it recovers. A gate that
     * refused it would leave the connection down forever after one bad
     * minute. */
    const retried = await service.sendTemplate(businessId, {
      to: '+2349098887777',
      name: 'payment_reminder',
    });
    expect(retried).toEqual({ outcome: 'sent', unit: 'UTILITY_TEMPLATE' });
    row = await withBusiness(db, businessId, (tx) => wabaRepo.wabaConnectionFor(tx, businessId));
    expect(row!.status).toBe('CONNECTED');
    expect(row!.healthReason).toBeNull();
    expect(row!.lastHealthyAt).not.toBeNull();
  });
});

describe('a customer who said STOP is not reachable by any route (PR-135)', () => {
  const CUSTOMER = '+2349098886666';

  const hashFor = (businessId: string, phoneNumberId: string) =>
    participantIndexFor(config.matchKey, {
      businessId,
      channelAccountId: phoneNumberId,
      keyVersion: PARTICIPANT_INDEX_KEY_VERSION,
      normalisedParticipant: CUSTOMER,
    });

  /** What the inbound handler writes; here it is set up directly. */
  const refuse = (businessId: string, phoneNumberId: string, at: Date | null) =>
    withBusiness(db, businessId, (tx) =>
      customerConsentRepo.setCustomerOptOut(
        tx,
        {
          businessId,
          channelAccountId: phoneNumberId,
          customerHash: hashFor(businessId, phoneNumberId),
          indexKeyVersion: PARTICIPANT_INDEX_KEY_VERSION,
        },
        at,
      ),
    );

  const openWindow = (businessId: string, connectionId: string, phoneNumberId: string) =>
    withBusiness(db, businessId, (tx) =>
      wabaRepo.touchServiceWindow(tx, {
        businessId,
        wabaConnectionId: connectionId,
        customerHash: hashFor(businessId, phoneNumberId),
      }),
    );

  it('a TEMPLATE is refused before the meter moves', async () => {
    const { businessId, connectionId, phoneNumberId } = await seedMerchant('integrate');
    await registerTemplate(businessId, connectionId, 'payment_reminder', 'UTILITY');
    await refuse(businessId, phoneNumberId, new Date());

    /* The template is the PROACTIVE route, and it is the one that has to
     * refuse: a window is something the customer opened, but a template
     * needs no permission from them at all except this one. */
    const outcome = await service.sendTemplate(businessId, {
      to: CUSTOMER,
      name: 'payment_reminder',
    });

    expect(outcome).toEqual({ outcome: 'suppressed' });
    expect(await used(businessId, 'UTILITY_TEMPLATE')).toBe(0);
  });

  it('FREE-FORM is refused even with the window wide open', async () => {
    const { businessId, connectionId, phoneNumberId } = await seedMerchant('integrate');
    await openWindow(businessId, connectionId, phoneNumberId);
    await refuse(businessId, phoneNumberId, new Date());

    /* An open window is Meta saying the shop MAY reply. Consent is the
     * customer saying it may not, and the customer's answer wins. */
    const outcome = await service.sendCustomerText(businessId, {
      to: CUSTOMER,
      text: 'Your order is ready for pickup',
    });

    expect(outcome).toEqual({ outcome: 'suppressed' });
    expect(sender.connectionTexts).toHaveLength(0);
    expect(await used(businessId, 'SERVICE_MESSAGE')).toBe(0);
  });

  it('START makes them reachable again, on both routes', async () => {
    const { businessId, connectionId, phoneNumberId } = await seedMerchant('integrate');
    await registerTemplate(businessId, connectionId, 'payment_reminder', 'UTILITY');
    await openWindow(businessId, connectionId, phoneNumberId);
    await refuse(businessId, phoneNumberId, new Date());
    await refuse(businessId, phoneNumberId, null);

    expect(
      await service.sendTemplate(businessId, { to: CUSTOMER, name: 'payment_reminder' }),
    ).toEqual({ outcome: 'sent', unit: 'UTILITY_TEMPLATE' });
    expect(
      await service.sendCustomerText(businessId, { to: CUSTOMER, text: 'On its way' }),
    ).toEqual({ outcome: 'sent', unit: 'SERVICE_MESSAGE' });
  });

  it('binds to the shop that was told, not to the person', async () => {
    const ada = await seedMerchant('integrate');
    const bola = await seedMerchant('integrate');
    await registerTemplate(ada.businessId, ada.connectionId, 'payment_reminder', 'UTILITY');
    await registerTemplate(bola.businessId, bola.connectionId, 'payment_reminder', 'UTILITY');
    await refuse(ada.businessId, ada.phoneNumberId, new Date());

    /* The same human being. Ada was told to stop; Bola was not, and Bola
     * has no way to learn that anybody was. */
    expect(
      await service.sendTemplate(ada.businessId, { to: CUSTOMER, name: 'payment_reminder' }),
    ).toEqual({ outcome: 'suppressed' });
    expect(
      await service.sendTemplate(bola.businessId, { to: CUSTOMER, name: 'payment_reminder' }),
    ).toEqual({ outcome: 'sent', unit: 'UTILITY_TEMPLATE' });
  });
});

describe('no transaction is held open while Meta is called (REM-02)', () => {
  const CUSTOMER = '+2349098885555';

  async function openWindow(businessId: string, connectionId: string, phoneNumberId: string) {
    await withBusiness(db, businessId, (tx) =>
      wabaRepo.touchServiceWindow(tx, {
        businessId,
        wabaConnectionId: connectionId,
        customerHash: participantIndexFor(config.matchKey, {
          businessId,
          channelAccountId: phoneNumberId,
          keyVersion: PARTICIPANT_INDEX_KEY_VERSION,
          normalisedParticipant: CUSTOMER,
        }),
      }),
    );
    /* A committed counter row, so the reservation below is an UPDATE of a row another request
     * can contend for (a fresh row inserted by the send would be invisible, not locked). */
    await withBusiness(db, businessId, (tx) =>
      usageRepo.creditBonus(tx, businessId, usagePeriod(new Date()), 'SERVICE_MESSAGE', 5),
    );
  }

  /** What another request sees while the provider call is in flight. */
  interface Observed {
    usageRowUpdated: boolean;
    outboundVisible: number;
    usedDuringCall: number;
  }

  /** A sender that, mid-call, writes the usage row from another connection under a short lock wait. */
  class ObservingSender extends StubSender {
    observed: Observed | null = null;
    constructor(
      private readonly businessId: string,
      private readonly then: (
        message: Parameters<StubSender['sendOnConnection']>[0],
      ) => Promise<unknown>,
    ) {
      super();
    }
    override async sendOnConnection(message: Parameters<StubSender['sendOnConnection']>[0]) {
      const businessId = this.businessId;
      let usageRowUpdated = false;
      try {
        await withBusiness(db, businessId, async (tx) => {
          await tx.execute(sql`SET LOCAL lock_timeout = '1500ms'`);
          await tx.execute(
            sql`UPDATE usage_counters SET updated_at = now()
                 WHERE business_id = ${businessId}::uuid AND unit = 'SERVICE_MESSAGE'`,
          );
        });
        usageRowUpdated = true;
      } catch {
        usageRowUpdated = false;
      }
      const [outbound] = [
        ...(await withBusiness(db, businessId, (tx) =>
          tx.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM conversation_messages
                 WHERE business_id = ${businessId}::uuid AND direction = 'outbound'`,
          ),
        )),
      ];
      this.observed = {
        usageRowUpdated,
        outboundVisible: outbound!.n,
        usedDuringCall: await used(businessId, 'SERVICE_MESSAGE'),
      };
      await this.then(message);
      return super.sendOnConnection(message);
    }
  }

  const serviceWith = (custom: StubSender) =>
    new WabaTemplateService(db, config, custom, new PrivacyGateway(db, config));

  it('reserves and records first, calls the provider with no lock held, then marks it sent', async () => {
    const { businessId, connectionId, phoneNumberId } = await seedMerchant('integrate');
    await openWindow(businessId, connectionId, phoneNumberId);
    const observing = new ObservingSender(businessId, async () => undefined);

    const outcome = await serviceWith(observing).sendCustomerText(businessId, {
      to: CUSTOMER,
      text: 'Your order is ready for pickup',
    });

    expect(outcome).toEqual({ outcome: 'sent', unit: 'SERVICE_MESSAGE' });
    expect(observing.observed).toEqual({
      usageRowUpdated: true,
      outboundVisible: 1,
      usedDuringCall: 1,
    });
    expect(await used(businessId, 'SERVICE_MESSAGE')).toBe(1);
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ provider_message_id: string | null }>(
        sql`SELECT provider_message_id FROM conversation_messages
            WHERE business_id = ${businessId}::uuid AND direction = 'outbound'`,
      ),
    );
    expect([...rows]).toEqual([{ provider_message_id: 'wamid.CTX1' }]);
  });

  it('keeps the unit when the provider outcome is unknown (a timeout), and reports it unknown', async () => {
    const { businessId, connectionId, phoneNumberId } = await seedMerchant('integrate');
    await openWindow(businessId, connectionId, phoneNumberId);
    const sender = new StubSender();
    sender.failWith(new SendFailed('meta /pn/messages timed out'));

    const outcome = await serviceWith(sender).sendCustomerText(businessId, {
      to: CUSTOMER,
      text: 'hello',
    });

    expect(outcome).toEqual({ outcome: 'send_failed', unit: 'SERVICE_MESSAGE', unknown: true });
    expect(await used(businessId, 'SERVICE_MESSAGE')).toBe(1);
  });

  it('refunds the unit in its own short transaction when the provider definitely refuses', async () => {
    const { businessId, connectionId, phoneNumberId } = await seedMerchant('integrate');
    await openWindow(businessId, connectionId, phoneNumberId);
    const observing = new ObservingSender(businessId, async () => {
      throw new SendFailed('meta /pn/messages failed with 400', null, true);
    });

    const outcome = await serviceWith(observing).sendCustomerText(businessId, {
      to: CUSTOMER,
      text: 'hello',
    });

    expect(outcome).toEqual({ outcome: 'send_failed', unit: 'SERVICE_MESSAGE' });
    expect(observing.observed?.usageRowUpdated).toBe(true);
    expect(await used(businessId, 'SERVICE_MESSAGE')).toBe(0);
    const row = await withBusiness(db, businessId, (tx) =>
      wabaRepo.wabaConnectionFor(tx, businessId),
    );
    expect(row!.status).toBe('UNHEALTHY');
  });

  it('keeps the unit and rethrows an unexpected sender error, because the message may have left', async () => {
    const { businessId, connectionId, phoneNumberId } = await seedMerchant('integrate');
    await openWindow(businessId, connectionId, phoneNumberId);
    const observing = new ObservingSender(businessId, async () => {
      throw new TypeError('socket hang up');
    });

    await expect(
      serviceWith(observing).sendCustomerText(businessId, { to: CUSTOMER, text: 'hello' }),
    ).rejects.toThrow('socket hang up');
    // Not a definite provider refusal (SendFailed): an error raised after the request went could
    // hide an accepted message, so nothing is refunded and no free send is possible.
    expect(await used(businessId, 'SERVICE_MESSAGE')).toBe(1);
  });

  it('reports sent, and keeps the unit, when recording after Meta accepted it fails', async () => {
    const { businessId, connectionId, phoneNumberId } = await seedMerchant('integrate');
    await openWindow(businessId, connectionId, phoneNumberId);
    const sender = new StubSender();
    const custom = serviceWith(sender);
    /* Step 3 (mark sent) fails after Meta returned a message id. The message went: a caller
     * told anything but `sent` could send it again. */
    (custom as unknown as { customerTextSent: () => Promise<void> }).customerTextSent =
      async () => {
        throw new Error('database unavailable');
      };

    const outcome = await custom.sendCustomerText(businessId, { to: CUSTOMER, text: 'hello' });

    expect(outcome).toEqual({
      outcome: 'sent',
      unit: 'SERVICE_MESSAGE',
      providerIdUnrecorded: true,
    });
    expect(sender.connectionTexts).toHaveLength(1);
    expect(await used(businessId, 'SERVICE_MESSAGE')).toBe(1);
  });

  it('when the real mark-sent write fails after Meta accepted: sent, flagged, unit kept, row findable, nothing resent', async () => {
    const { businessId, connectionId, phoneNumberId } = await seedMerchant('integrate');
    await openWindow(businessId, connectionId, phoneNumberId);
    const sender = new StubSender();
    const custom = serviceWith(sender);
    /* The actual persistence step (`markOutboundSent`, an UPDATE of the outbound row) is made to
     * fail in the database, after the stub has returned a provider message id. */
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    await ownerDb.execute(sql`
      CREATE OR REPLACE FUNCTION test_refuse_outbound_update() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'refused for test'; END $$ LANGUAGE plpgsql`);
    await ownerDb.execute(sql`
      CREATE TRIGGER test_refuse_outbound_update BEFORE UPDATE ON conversation_messages
      FOR EACH ROW EXECUTE FUNCTION test_refuse_outbound_update()`);
    try {
      const outcome = await custom.sendCustomerText(businessId, { to: CUSTOMER, text: 'hello' });

      expect(outcome).toEqual({
        outcome: 'sent',
        unit: 'SERVICE_MESSAGE',
        providerIdUnrecorded: true,
      });
      expect(sender.connectionTexts).toHaveLength(1);
      expect(await used(businessId, 'SERVICE_MESSAGE')).toBe(1);
      const rows = await withBusiness(db, businessId, (tx) =>
        tx.execute<{ provider_message_id: string | null }>(
          sql`SELECT provider_message_id FROM conversation_messages
              WHERE business_id = ${businessId}::uuid AND direction = 'outbound'`,
        ),
      );
      expect([...rows]).toEqual([{ provider_message_id: null }]);
    } finally {
      await ownerDb.execute(
        sql`DROP TRIGGER IF EXISTS test_refuse_outbound_update ON conversation_messages`,
      );
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS test_refuse_outbound_update()`);
      await close();
    }
  });

  it('flags a send Meta accepted (2xx) without returning a message id as sent with the id unrecorded', async () => {
    const { businessId, connectionId, phoneNumberId } = await seedMerchant('integrate');
    await openWindow(businessId, connectionId, phoneNumberId);
    const sender = new StubSender();
    sender.sendOnConnection = async () => ({ providerMessageId: null });

    const outcome = await serviceWith(sender).sendCustomerText(businessId, {
      to: CUSTOMER,
      text: 'hello',
    });

    expect(outcome).toEqual({
      outcome: 'sent',
      unit: 'SERVICE_MESSAGE',
      providerIdUnrecorded: true,
    });
    expect(await used(businessId, 'SERVICE_MESSAGE')).toBe(1);
  });

  it('flags a 2xx with no message id the same way for a caller passing its own transaction', async () => {
    const { businessId, connectionId, phoneNumberId } = await seedMerchant('integrate');
    await openWindow(businessId, connectionId, phoneNumberId);
    const sender = new StubSender();
    sender.sendOnConnection = async () => ({ providerMessageId: null });
    const custom = serviceWith(sender);

    const outcome = await withBusiness(db, businessId, (tx) =>
      custom.sendCustomerText(businessId, { to: CUSTOMER, text: 'hello' }, tx),
    );

    expect(outcome).toEqual({
      outcome: 'sent',
      unit: 'SERVICE_MESSAGE',
      providerIdUnrecorded: true,
    });
    expect(await used(businessId, 'SERVICE_MESSAGE')).toBe(1);
  });

  it('names the outbound row and the error class, never the text, when recording after Meta accepted it fails', async () => {
    const { businessId, connectionId, phoneNumberId } = await seedMerchant('integrate');
    await openWindow(businessId, connectionId, phoneNumberId);
    const custom = serviceWith(new StubSender());
    (custom as unknown as { customerTextSent: () => Promise<void> }).customerTextSent =
      async () => {
        throw new RangeError('secret db detail 08012345678');
      };
    const warn = vi.spyOn((custom as unknown as { log: Logger }).log, 'warn');

    await custom.sendCustomerText(businessId, { to: CUSTOMER, text: 'private body text' });

    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ id: string }>(
        sql`SELECT id FROM conversation_messages
            WHERE business_id = ${businessId}::uuid AND direction = 'outbound'`,
      ),
    );
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain(`outbound ${[...rows][0]!.id}`);
    expect(line).toContain('RangeError');
    expect(line).not.toContain('private body text');
    expect(line).not.toContain('secret db detail');
    expect(line).not.toContain(CUSTOMER);
  });

  it('keeps the unit, names the outbound row and rethrows when the sender fails with a non-provider error', async () => {
    const { businessId, connectionId, phoneNumberId } = await seedMerchant('integrate');
    await openWindow(businessId, connectionId, phoneNumberId);
    const sender = new StubSender();
    sender.sendOnConnection = async () => {
      throw new TypeError('body was null for 08012345678');
    };
    const custom = serviceWith(sender);
    const warn = vi.spyOn((custom as unknown as { log: Logger }).log, 'warn');

    await expect(
      custom.sendCustomerText(businessId, { to: CUSTOMER, text: 'private body text' }),
    ).rejects.toBeInstanceOf(TypeError);

    /* The message may have left: nothing is refunded. */
    expect(await used(businessId, 'SERVICE_MESSAGE')).toBe(1);
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ id: string; provider_message_id: string | null }>(
        sql`SELECT id, provider_message_id FROM conversation_messages
            WHERE business_id = ${businessId}::uuid AND direction = 'outbound'`,
      ),
    );
    expect([...rows]).toHaveLength(1);
    expect([...rows][0]!.provider_message_id).toBeNull();
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain(`outbound ${[...rows][0]!.id}`);
    expect(line).toContain('TypeError');
    expect(line).not.toContain('private body text');
    expect(line).not.toContain('body was null');
  });

  it('keeps the old single-transaction shape for a caller passing its own transaction', async () => {
    const { businessId, connectionId, phoneNumberId } = await seedMerchant('integrate');
    await openWindow(businessId, connectionId, phoneNumberId);
    const observing = new ObservingSender(businessId, async () => undefined);
    const custom = serviceWith(observing);

    /* PR-090: the customer-message job sends inside its own transaction, so the window its own
     * uncommitted touch opened is visible and its writes commit or roll back with the job. */
    const outcome = await withBusiness(db, businessId, (tx) =>
      custom.sendCustomerText(businessId, { to: CUSTOMER, text: 'hello' }, tx),
    );
    expect(outcome).toEqual({ outcome: 'sent', unit: 'SERVICE_MESSAGE' });
    expect(observing.observed?.outboundVisible).toBe(0);
    expect(observing.observed?.usageRowUpdated).toBe(false);
    expect(await used(businessId, 'SERVICE_MESSAGE')).toBe(1);
  });
});
