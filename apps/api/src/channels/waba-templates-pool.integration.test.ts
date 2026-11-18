/**
 * A customer text sent on its own holds one application connection at a time (closeout round G of
 * PR #432, owner instruction of 18 Nov 2026, §4.5: the connection budget).
 *
 * `sendCustomerText` without the caller's transaction reserves the unit and records the outbound
 * message in one transaction. Inside it, `PrivacyGateway.tokenise` looked customer names up (and
 * could create a customer for a phone or email in the text) through repository calls that each
 * took ANOTHER connection from the same pool. Called from a job (the catalogue checkout's
 * `payment.link`) that is a third connection per lane, beyond the lanes + 2 the worker's pool
 * leaves (`appPoolSize`); called from the reminder sweep or an API request it is a second
 * connection held while waiting for another. The gateway now runs those lookups on the
 * reservation's own transaction (savepoints on the same connection).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, sql, wabaRepo, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, setPlanForTest, truncateAll, type Urls } from '@rekoda/db/testing';
import {
  encryptFacet,
  participantIndexFor,
  PARTICIPANT_INDEX_KEY_VERSION,
} from '@rekoda/core/vault';
import { StubSender } from './sender.stub.js';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { WabaTemplateService } from './waba-templates.service.js';
import { loadConfig, type ApiConfig } from '../config.js';
import { probePool } from '../db/pool-probe.fixtures.js';

const CUSTOMER = '+2349098887777';
let urls: Urls;
let db: Db;
let closeDb: () => Promise<void>;
let config: ApiConfig;
const sender = new StubSender();

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
});
afterAll(async () => {
  await closeDb?.();
});
beforeEach(async () => {
  await truncateAll(urls);
  sender.reset();
});

/** An Integrate merchant with a connected number and the customer's service window open. */
async function merchantWithOpenWindow(): Promise<string> {
  const user = await identity.upsertUserByPhone(db, '+2348187000901');
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  await setPlanForTest(db, {
    businessId: business.id,
    plan: 'integrate',
    expiresAt: null,
    actor: 'operator:test',
  });
  const phoneNumberId = 'pn-pool-1';
  const connected = await withBusiness(db, business.id, (tx) =>
    wabaRepo.connectWaba(tx, {
      businessId: business.id,
      wabaId: 'waba-pool-1',
      phoneNumberId,
      accessTokenCipher: encryptFacet(
        'EAAB-token',
        config.connectionKey,
        `${business.id}:waba_token`,
      ),
      tokenTail: 'oken',
    }),
  );
  if (connected.outcome !== 'connected') throw new Error('fixture: signup failed');
  const hash = participantIndexFor(config.matchKey, {
    businessId: business.id,
    channelAccountId: phoneNumberId,
    keyVersion: PARTICIPANT_INDEX_KEY_VERSION,
    normalisedParticipant: CUSTOMER,
  });
  await withBusiness(db, business.id, (tx) =>
    wabaRepo.touchServiceWindow(tx, {
      businessId: business.id,
      wabaConnectionId: connected.id,
      customerHash: hash,
    }),
  );
  return business.id;
}

describe('a standalone customer text and the application pool', () => {
  it('holds one connection at a time while it tokenises names, phones and emails, and still sends', async () => {
    const businessId = await merchantWithOpenWindow();
    const probe = probePool(db);
    const service = new WabaTemplateService(
      probe.db,
      config,
      sender,
      new PrivacyGateway(probe.db, config),
    );
    /* A name (looked up), a phone and an email (each resolved, and created as a customer). */
    const outcome = await service.sendCustomerText(businessId, {
      to: CUSTOMER,
      text: 'Ada, your order is ready. Questions: +2348031112222 or help@shop.example.ng',
    });
    expect(outcome).toEqual({ outcome: 'sent', unit: 'SERVICE_MESSAGE' });
    expect(probe.highWater()).toBe(1);
    /* The text the history keeps is still tokenised (no phone or email in it). */
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ body: string }>(sql`
        SELECT body FROM conversation_messages
        WHERE business_id = ${businessId}::uuid AND direction = 'outbound'`),
    );
    const body = [...rows][0]!.body;
    expect(body).not.toContain('2348031112222');
    expect(body).not.toContain('help@shop.example.ng');
    expect(sender.connectionTexts).toHaveLength(1);
  });
});
