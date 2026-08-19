/**
 * The authorised output layer (MASTER-PLAN §5.3.2, ADR 0005).
 *
 * One claim runs through this whole file: a real customer name exists outside
 * the vault only in the argument to `send`, and never in a row. `rehydrate` is
 * held back from `@rekoda/core`'s barrel precisely because it can undo the
 * privacy gateway — so the place it IS called deserves a test that would
 * notice if it moved.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  conversationsRepo,
  createDb,
  identity,
  quotaRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { replies } from '@rekoda/core';
import { ReplySender } from './reply.service.js';
import { StubSender } from '../channels/sender.stub.js';
import { loadConfig, type ApiConfig } from '../config.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;
let config: ApiConfig;
let sender: StubSender;
let replySender: ReplySender;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 4 }));

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  config = loadConfig();
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
  sender = new StubSender();
  replySender = new ReplySender(config, sender);
});

async function seedBusiness(): Promise<string> {
  const user = await identity.upsertUserByPhone(db, '+2348090000001');
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

function messagesOf(businessId: string) {
  return withBusiness(db, businessId, (tx) => conversationsRepo.messagesFor(tx, businessId));
}

describe('rehydration happens at the boundary and nowhere before it', () => {
  it('sends the real name and stores the token', async () => {
    const businessId = await seedBusiness();
    const tokens = new Map([['CUSTOMER_7K2', 'Adaeze Okonkwo']]);

    await withBusiness(db, businessId, (tx) =>
      replySender.send(tx, {
        businessId,
        to: '2348031234567',
        reply: { text: 'CUSTOMER_7K2 now owes ₦50,000.' },
        tokens,
      }),
    );

    // What the merchant reads.
    expect(sender.lastText).toBe('Adaeze Okonkwo now owes ₦50,000.');

    // What the database holds. If these two were the same string, the gateway
    // would be decorative.
    const [stored] = await messagesOf(businessId);
    expect(stored!.body).toBe('CUSTOMER_7K2 now owes ₦50,000.');
    expect(stored!.body).not.toContain('Adaeze');
  });

  it('substitutes the longest token first', async () => {
    const businessId = await seedBusiness();
    const tokens = new Map([
      ['CUSTOMER_1', 'Ada'],
      ['CUSTOMER_12', 'Bola'],
    ]);

    await withBusiness(db, businessId, (tx) =>
      replySender.send(tx, {
        businessId,
        to: '2348031234567',
        reply: { text: 'CUSTOMER_12 paid CUSTOMER_1.' },
        tokens,
      }),
    );

    // Shortest-first would rewrite CUSTOMER_12 into "Ada2" and name the wrong
    // person on a message about money.
    expect(sender.lastText).toBe('Bola paid Ada.');
  });

  it('sends a reply with no tokens unchanged', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      replySender.send(tx, { businessId, to: '2348031234567', reply: replies.greeting() }),
    );
    expect(sender.lastText).toBe(replies.greeting().text);
  });
});

describe('a reply that could not be delivered', () => {
  it('is still on record, and findable as undelivered', async () => {
    const businessId = await seedBusiness();
    sender.failWith();

    const result = await withBusiness(db, businessId, (tx) =>
      replySender.send(tx, { businessId, to: '2348031234567', reply: replies.greeting() }),
    );
    expect(result.delivered).toBe(false);

    const [stored] = await messagesOf(businessId);
    expect(stored).toMatchObject({ direction: 'outbound', providerMessageId: null });
  });

  it('does not bill a message that never left', async () => {
    const businessId = await seedBusiness();
    sender.failWith();
    await withBusiness(db, businessId, (tx) =>
      replySender.send(tx, { businessId, to: '2348031234567', reply: replies.greeting() }),
    );

    const spend = await withBusiness(db, businessId, (tx) => quotaRepo.usageTotals(tx, 'meta'));
    expect(spend.calls).toBe(0);
  });

  it('records the message cost when it did leave', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      replySender.send(tx, { businessId, to: '2348031234567', reply: replies.greeting() }),
    );

    /**
     * Zero naira today — an in-window service reply is currently free
     * Meta-side. The row still matters: it becomes chargeable on 1 October
     * 2026, and a count that starts on the day the price does has no baseline
     * to compare against.
     */
    const spend = await withBusiness(db, businessId, (tx) => quotaRepo.usageTotals(tx, 'meta'));
    expect(spend.calls).toBe(1);
    expect(spend.providerCostMicros).toBe(0);
  });
});

describe('what will not be sent', () => {
  it('refuses an empty reply rather than sending a blank message', async () => {
    const businessId = await seedBusiness();
    const result = await withBusiness(db, businessId, (tx) =>
      replySender.send(tx, { businessId, to: '2348031234567', reply: { text: '   ' } }),
    );

    expect(result.delivered).toBe(false);
    expect(sender.sent).toHaveLength(0);
    // And nothing is recorded either — there is no message to have a record of.
    expect(await messagesOf(businessId)).toHaveLength(0);
  });

  it('truncates an over-long reply instead of dropping it', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      replySender.send(tx, {
        businessId,
        to: '2348031234567',
        // A model's clarification is interpolated verbatim, so this is reachable.
        reply: { text: 'x'.repeat(5_000) },
      }),
    );

    expect(sender.lastText!.length).toBe(replies.MAX_REPLY_CHARS);
    expect(sender.sent).toHaveLength(1);
  });
});

describe('tenancy', () => {
  it('does not show one business another`s replies', async () => {
    const ada = await seedBusiness();
    const bolaUser = await identity.upsertUserByPhone(db, '+2348090000002');
    const bola = await identity.createBusinessWithOwner(db, {
      name: 'Bola Electronics',
      businessType: null,
      ownerUserId: bolaUser.id,
    });

    await withBusiness(db, ada, (tx) =>
      replySender.send(tx, { businessId: ada, to: '2348031234567', reply: replies.greeting() }),
    );

    expect(await messagesOf(ada)).toHaveLength(1);
    expect(await messagesOf(bola.id)).toHaveLength(0);
  });
});
