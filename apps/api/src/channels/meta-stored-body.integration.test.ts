/**
 * What the conversation history keeps of a message (G-136, owner directive on #437,
 * 20 Nov 2026): what it WAS, never what it said.
 *
 * Before: the tokenised text was stored before the model ran, so a name nobody had
 * recorded was kept in full on every path that never reached the after-model scrub
 * (a model failure, an unclear message, a supplier), and only the words the model
 * returned were taken out on the paths that did ("[name] Okafor"). Nothing in
 * production reads this column, so none of the text is kept: a structural
 * placeholder is all that commits. The model still reads the message (in memory),
 * and the draft, figures and replies are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { conversationsRepo, identity, withBusiness, sql } from '@rekoda/db';
import { STORED_BODY } from '@rekoda/core/privacy';
import {
  db,
  deps,
  messagePayload,
  post,
  stubSender,
  stubStt,
  stubTransport,
  useMetaWebhookHarness,
} from './meta-webhook.fixtures.js';
import { arrangeAudio, drain, voicePayload } from './meta-voice-note.fixtures.js';
import { openPayload } from '../privacy/payload-vault.js';

useMetaWebhookHarness();

const OWNER = '2348031234567';

async function seedMerchant() {
  const user = await identity.upsertUserByPhone(db, `+${OWNER}`);
  return identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
}

async function say(wamid: string, text: string) {
  await post(messagePayload(OWNER, wamid, text));
  await drain();
}

/** Every stored row of the conversation, inbound and outbound, oldest first. */
const history = (businessId: string) =>
  withBusiness(db, businessId, async (tx) => [
    ...(await tx.execute<{ direction: string; body: string; provider_message_id: string | null }>(
      sql`SELECT direction, body, provider_message_id FROM conversation_messages
          WHERE business_id = ${businessId}::uuid ORDER BY created_at, id`,
    )),
  ]);

const inboundBody = async (businessId: string, wamid: string) =>
  (await history(businessId)).filter((r) => r.provider_message_id === wamid).map((r) => r.body);

const everythingStored = async (businessId: string) =>
  (await history(businessId)).map((r) => r.body).join('\n');

const lastModelText = () => stubTransport.requests.at(-1)?.userText ?? '';

const A_SALE = (customer: Record<string, unknown>) => ({
  intent: 'RecordSale',
  customer,
  items: [{ name: 'Samsung Galaxy S25', quantity: 1, unitPrice: 900_000 }],
  statedTotal: 900_000,
  reportedPayment: 0,
  paymentMethod: 'transfer',
  discount: null,
  deliveryFee: null,
  dueDescription: null,
});

describe('the stored copy of a message keeps no name (G-136)', () => {
  it('a model that is unavailable leaves no name behind', async () => {
    const business = await seedMerchant();
    stubTransport.script(new Error('provider timed out'));

    await say('wamid.SB1', 'how much does Chiamaka Okafor owe me');

    expect(await inboundBody(business.id, 'wamid.SB1')).toEqual([STORED_BODY.text]);
    expect(await everythingStored(business.id)).not.toMatch(/Chiamaka|Okafor/);
  });

  it('an unclear message leaves no name behind, and the clarification is sent but not kept', async () => {
    const business = await seedMerchant();
    stubTransport.replyWith({
      intent: 'Unclear',
      clarification: 'Did you mean a sale to Chiamaka Okafor?',
    });

    await say('wamid.SB2', 'Chiamaka Okafor the usual');

    expect(stubSender.lastText).toBe('Did you mean a sale to Chiamaka Okafor?');
    expect(await inboundBody(business.id, 'wamid.SB2')).toEqual([STORED_BODY.text]);
    const stored = await history(business.id);
    expect(stored.filter((r) => r.direction === 'outbound').map((r) => r.body)).toEqual([
      STORED_BODY.reply,
    ]);
    expect(await everythingStored(business.id)).not.toMatch(/Chiamaka|Okafor/);
  });

  it('a question whose model returned part of the name keeps no part of it', async () => {
    const business = await seedMerchant();
    stubTransport.replyWith({
      intent: 'Query',
      topic: 'customer_balance',
      customer: { kind: 'mention', mention: 'Chiamaka' },
      period: 'month',
      periodText: null,
      format: 'chat',
    });

    await say('wamid.SB3', 'how much does Chiamaka Okafor owe me');

    expect(stubSender.lastText).toContain('do not have a customer by that name');
    expect(await inboundBody(business.id, 'wamid.SB3')).toEqual([STORED_BODY.text]);
    expect(await everythingStored(business.id)).not.toMatch(/Chiamaka|Okafor/);
  });

  it('a sale keeps its product and figures in the draft and no name in the history', async () => {
    const business = await seedMerchant();
    stubTransport.replyWith(A_SALE({ kind: 'mention', mention: 'Chiamaka' }));

    await say('wamid.SB4', 'Sold Chiamaka Okafor Samsung Galaxy S25 for ₦900,000');

    /* The model read the message (in memory); the preview carries the product. */
    expect(lastModelText()).toContain('Samsung Galaxy S25');
    expect(stubSender.lastText).toContain('Samsung Galaxy S25');
    const drafts = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.pendingDraftToAnswer(tx, business.id, { asOf: new Date() }),
    );
    expect(JSON.stringify(drafts?.command)).toContain('Samsung Galaxy S25');
    expect(JSON.stringify(drafts?.command)).toContain('900000');
    expect(await inboundBody(business.id, 'wamid.SB4')).toEqual([STORED_BODY.text]);
    expect(await everythingStored(business.id)).not.toMatch(/Okafor/);
  });

  it('a supplier named in a purchase is not kept in the history', async () => {
    const business = await seedMerchant();
    stubTransport.replyWith({
      intent: 'RecordPurchase',
      supplierMention: 'Emeka Nwosu',
      description: '10 cartons',
      amount: 100_000,
      reportedPayment: 100_000,
      paymentMethod: 'pos',
      productMention: 'cartons',
      quantity: 10,
    });

    await say('wamid.SB5', 'bought 10 cartons from Emeka Nwosu for 100k pos');

    expect(await inboundBody(business.id, 'wamid.SB5')).toEqual([STORED_BODY.text]);
    /* "Emeka" is also a word of the reply's fixed example sentence, so the surname
     * is the honest probe; and no reply is kept as text at all. */
    expect(await everythingStored(business.id)).not.toMatch(/Nwosu/);
    const replies = (await history(business.id)).filter((r) => r.direction === 'outbound');
    expect(replies.length).toBeGreaterThan(0);
    expect(new Set(replies.map((r) => r.body))).toEqual(new Set([STORED_BODY.reply]));
  });

  it('a voice note keeps no transcript', async () => {
    const business = await seedMerchant();
    arrangeAudio();
    stubStt.answerWith({
      text: 'how much does Chiamaka Okafor owe me',
      seconds: 3,
      confidence: 0.95,
    });
    stubTransport.script(new Error('provider timed out'));

    await post(voicePayload(OWNER, 'wamid.SB6'));
    await drain();

    expect(await inboundBody(business.id, 'wamid.SB6')).toEqual([STORED_BODY.voice]);
    expect(await everythingStored(business.id)).not.toMatch(/Chiamaka|Okafor/);
  });

  it('a redelivered message is stored once, as the placeholder', async () => {
    const business = await seedMerchant();
    stubTransport.script(new Error('provider timed out'));

    await say('wamid.SB7', 'how much does Chiamaka Okafor owe me');
    await say('wamid.SB7', 'how much does Chiamaka Okafor owe me');

    expect(await inboundBody(business.id, 'wamid.SB7')).toEqual([STORED_BODY.text]);
  });

  it('a deterministic command is still stored as what it was', async () => {
    const business = await seedMerchant();

    await say('wamid.SB8', 'who owes me');

    const [body] = await inboundBody(business.id, 'wamid.SB8');
    expect(body).not.toBe(STORED_BODY.text);
    expect(body).toMatch(/^\[/);
    expect(stubTransport.requests).toHaveLength(0);
  });
});

/**
 * A delivery Meta batched for two businesses (CodeRabbit on #437): each business's event
 * row seals only its own message, so one business's DELETE MY DATA leaves no copy of its
 * message under the other's row.
 */
describe('a webhook body batched for two businesses', () => {
  it("seals each business's message under its own event only", async () => {
    const owners = ['2348031230001', '2348031230002'];
    const businesses = [];
    for (const [n, phone] of owners.entries()) {
      const user = await identity.upsertUserByPhone(db, `+${phone}`);
      businesses.push(
        await identity.createBusinessWithOwner(db, {
          name: `Shop ${n}`,
          businessType: null,
          ownerUserId: user.id,
        }),
      );
    }
    const one = messagePayload(owners[0]!, 'wamid.BATCH-A', 'sold Chiamaka Okafor 2 wigs');
    const two = messagePayload(owners[1]!, 'wamid.BATCH-B', 'Bola Ige paid 5k');
    one.entry[0]!.changes[0]!.value.messages.push(two.entry[0]!.changes[0]!.value.messages[0]!);
    await post(one);

    const sealed = async (businessId: string) =>
      withBusiness(db, businessId, async (tx) => {
        const [row] = [
          ...(await tx.execute<{ payload: unknown; external_id: string }>(sql`
            SELECT payload, external_id FROM external_events
             WHERE business_id = ${businessId}::uuid AND event_type LIKE 'message.%'`)),
        ];
        return JSON.stringify(
          openPayload(row!.payload, deps.config.vaultKey, 'meta', row!.external_id),
        );
      });
    const first = await sealed(businesses[0]!.id);
    const second = await sealed(businesses[1]!.id);
    expect(first).toContain('Chiamaka Okafor');
    expect(first).not.toContain('Bola Ige');
    expect(second).toContain('Bola Ige');
    expect(second).not.toContain('Chiamaka Okafor');
  });
});
