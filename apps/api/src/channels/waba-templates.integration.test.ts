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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  billingRepo,
  usageRepo,
  conversationsRepo,
  createDb,
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
