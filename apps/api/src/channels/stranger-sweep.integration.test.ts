/**
 * Answering someone who is not a merchant yet, against real PostgreSQL.
 *
 * The claims worth a database are all about repetition: an unattributed event
 * must be answered once and never again, a backlog of ten messages from one
 * person is still one greeting, and an outage must not turn either into a
 * loop the stranger cannot stop.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { replies } from '@rekoda/core';
import { createDb, events, identity, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { SendFailed } from './sender.js';
import { StubSender } from './sender.stub.js';
import { sealPayload } from '../privacy/payload-vault.js';
import { sweepUnknownSenders } from './stranger-sweep.js';

let urls: Urls;
let workerDb: Db;
let closeWorker: () => Promise<void>;
const sender = new StubSender();
const vaultKey = randomBytes(32).toString('hex');
const matchKey = randomBytes(32).toString('hex');

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));
});

afterAll(async () => {
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
  sender.reset();
});

const deps = () => ({ workerDb, sender, vaultKey, matchKey, metaPhoneNumberId: 'PNID' });

function messageBody(from: string, wamid: string, text = 'hello', phoneNumberId = 'PNID') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: phoneNumberId },
              messages: [
                { id: wamid, from, timestamp: '1700000000', type: 'text', text: { body: text } },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** An event as the webhook stores one: sealed, unattributed, unprocessed. */
async function arrive(
  from: string,
  wamid: string,
  eventType = 'message.text',
  phoneNumberId = 'PNID',
) {
  return events.recordEvent(workerDb, {
    provider: 'meta',
    eventType,
    externalId: wamid,
    payload: sealPayload(messageBody(from, wamid, 'hello', phoneNumberId), vaultKey, 'meta', wamid),
    businessId: null,
  });
}

describe('sweeping unknown senders', () => {
  it('answers a stranger once, with the sign-up reply', async () => {
    await arrive('2348031111111', 'wamid.stranger.1');

    const answered = await sweepUnknownSenders(deps());

    expect(answered).toBe(1);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.text).toBe(replies.noAccount().text);
    expect(sender.sent[0]?.to).toBe('+2348031111111');
  });

  it('does not answer the same person again on the next pass', async () => {
    await arrive('2348031111111', 'wamid.stranger.1');
    await sweepUnknownSenders(deps());
    sender.reset();

    await arrive('2348031111111', 'wamid.stranger.2');
    const answered = await sweepUnknownSenders(deps());

    expect(answered).toBe(0);
    expect(sender.sent).toHaveLength(0);
  });

  it("never greets a customer of somebody's WABA (PR-059): not our relationship", async () => {
    await arrive('2348035555555', 'wamid.foreign.1', 'message.text', 'PN-NOT-OURS');

    const answered = await sweepUnknownSenders(deps());

    expect(answered).toBe(0);
    expect(sender.sent).toHaveLength(0);
    /* Marked with a reason, not left pending: the refusal is recorded once
     * and the backlog cannot grow forever. */
    expect(await events.unattributedEvents(workerDb, 'meta')).toHaveLength(0);
  });

  it('sends one greeting for a backlog of ten messages from one person', async () => {
    for (let i = 0; i < 10; i += 1) await arrive('2348032222222', `wamid.backlog.${i}`);

    await sweepUnknownSenders(deps());

    expect(sender.sent).toHaveLength(1);
  });

  it('answers two different strangers', async () => {
    await arrive('2348031111111', 'wamid.a');
    await arrive('2348039999999', 'wamid.b');

    const answered = await sweepUnknownSenders(deps());

    expect(answered).toBe(2);
    expect(sender.sent.map((m) => m.to).sort()).toEqual(['+2348031111111', '+2348039999999']);
  });

  it('leaves nothing pending, so a later pass cannot answer twice', async () => {
    await arrive('2348031111111', 'wamid.stranger.1');
    await sweepUnknownSenders(deps());

    expect(await events.unattributedEvents(workerDb, 'meta')).toHaveLength(0);
  });

  it('marks the event processed even when the send fails', async () => {
    await arrive('2348031111111', 'wamid.stranger.1');
    sender.failWith(new SendFailed('meta outage'));

    const answered = await sweepUnknownSenders(deps());

    expect(answered).toBe(0);
    expect(await events.unattributedEvents(workerDb, 'meta')).toHaveLength(0);
  });

  it('does not greet anybody for a delivery receipt', async () => {
    await events.recordEvent(workerDb, {
      provider: 'meta',
      eventType: 'message.status',
      externalId: 'wamid.status.1',
      payload: sealPayload(
        { object: 'whatsapp_business_account', entry: [] },
        vaultKey,
        'meta',
        'wamid.status.1',
      ),
      businessId: null,
    });

    const answered = await sweepUnknownSenders(deps());

    expect(answered).toBe(0);
    expect(sender.sent).toHaveLength(0);
    expect(await events.unattributedEvents(workerDb, 'meta')).toHaveLength(0);
  });

  /**
   * The exception queue only counts exceptions.
   *
   * `error` on a processed event is what the ops health surface reports as
   * "flagged", so marking every stranger with a reason would bury the real
   * failures under the ordinary case this sweep exists for.
   */
  it('does not count an answered stranger as a flagged event', async () => {
    await arrive('2348031111111', 'wamid.stranger.1');
    await sweepUnknownSenders(deps());

    const health = await events.eventHealth(workerDb, 'meta');
    expect(health.unprocessed).toBe(0);
    expect(health.flagged).toBe(0);
  });

  it('does flag a message whose payload will not open', async () => {
    await events.recordEvent(workerDb, {
      provider: 'meta',
      eventType: 'message.text',
      externalId: 'wamid.flagme',
      payload: { not: 'sealed' },
      businessId: null,
    });
    await sweepUnknownSenders(deps());

    expect((await events.eventHealth(workerDb, 'meta')).flagged).toBe(1);
  });

  it('sets an unopenable payload aside rather than stalling on it', async () => {
    await events.recordEvent(workerDb, {
      provider: 'meta',
      eventType: 'message.text',
      externalId: 'wamid.corrupt',
      payload: { not: 'sealed' },
      businessId: null,
    });

    const answered = await sweepUnknownSenders(deps());

    expect(answered).toBe(0);
    expect(await events.unattributedEvents(workerDb, 'meta')).toHaveLength(0);
  });

  it('leaves an attributed event alone: that one belongs to a merchant', async () => {
    const user = await identity.upsertUserByPhone(workerDb, '+2348030000009');
    const business = await identity.createBusinessWithOwner(workerDb, {
      name: 'Ada Stores',
      businessType: null,
      ownerUserId: user.id,
    });
    const stored = await arrive('2348031111111', 'wamid.mine');
    expect(await events.attributeEvent(workerDb, stored.id, business.id)).toBe(true);

    const answered = await sweepUnknownSenders(deps());

    expect(answered).toBe(0);
    expect(sender.sent).toHaveLength(0);
  });
});
