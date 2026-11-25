/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1). A preview has a time limit (G-23), part 3 of 3,
 * split by concern from meta.integration.test.ts; shared helpers are in meta-webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  createDb,
  withBusiness,
  sql,
  type Db,
  customersRepo,
  conversationsRepo,
  identity,
} from '@rekoda/db';
import { replies } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
import {
  db,
  deps,
  messagePayload,
  post,
  stubSender,
  stubStt,
  stubTransport,
  urls,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';
import {
  A_SALE,
  seedMerchant,
  drain,
  say,
  plain,
  lapse,
  states,
  footprint,
  used,
  receipt,
  lastWamid,
  draftStates,
  previewFlags,
  AN_EXPENSE,
} from './meta-preview-expiry.fixtures.js';
import { arrangeAudio, drain as drainR, voicePayload } from './meta-voice-note.fixtures.js';
import {
  OWNER,
  footprint as footprintR,
  plain as plainR,
  sale,
  say as sayR,
  seedMerchant as seedMerchantR,
} from './meta-customer-token.fixtures.js';
import { answered, mediaMessage } from './meta-continuations.fixtures.js';
import { killInboundJob, queueOnly } from './meta-lost-message.fixtures.js';

useMetaWebhookHarness();

/**
 * Attempt 1 of the next "yes" meters, claims, then fails issuing (a fail-once trigger on invoices):
 * the job rolls back and is retried later, so other messages can be handled before it. Test-scoped,
 * on the owner.
 */
async function withFirstInvoiceFailing(run: (owner: Db) => Promise<void>) {
  const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
  try {
    await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g23_once`);
    await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g23_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF nextval('g23_once') = 1 THEN RAISE EXCEPTION 'g23: first attempt fails'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
    await ownerDb.execute(sql`
        CREATE TRIGGER g23_fail_once BEFORE INSERT ON invoices
          FOR EACH ROW EXECUTE FUNCTION g23_fail_once()`);
    await run(ownerDb);
  } finally {
    await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g23_fail_once ON invoices`);
    await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g23_fail_once()`);
    await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g23_once`);
    await close();
  }
}

/** Push every job still waiting for this business an hour out. */
const holdRetries = (owner: Db, businessId: string) =>
  owner.execute(sql`
      UPDATE jobs SET run_at = now() + interval '1 hour'
       WHERE business_id = ${businessId}::uuid AND state <> 'done'`);

/** Make every job still waiting for this business due now. */
const runRetriesNow = (owner: Db, businessId: string) =>
  owner.execute(sql`
      UPDATE jobs SET run_at = now() WHERE business_id = ${businessId}::uuid AND state <> 'done'`);

/**
 * A preview has a time limit (G-23, migration 0153).
 *
 * A "yes" executes a preview only inside its confirmation window. Monday's
 * preview answered on Thursday records nothing, costs nothing, and the
 * merchant is told it expired and to send it again. Time is moved by closing
 * the window in the database (`expires_at` set into the past), never by
 * sleeping; the boundary instant itself is pinned in draft-expiry.
 */
describe('a preview has a time limit (G-23)', () => {
  it('a retried yes whose draft a correction superseded while it waited gives the unit back', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-sup1', A_SALE, 'sold Ada 3 wigs for 300k');

    await withFirstInvoiceFailing(async (owner) => {
      await post(messagePayload('2348031234567', 'wamid.G23-sup1-yes', 'yes'));
      await buildRunner(workerDb, db, deps).runOnce();
      expect((await used(business.id)).documents).toBe(1);
      await holdRetries(owner, business.id);

      /* The merchant corrects it before the retry runs. */
      await say(
        'wamid.G23-sup2',
        {
          ...A_SALE,
          items: [{ name: 'wig', quantity: 4, unitPrice: 100_000 }],
          statedTotal: 400_000,
        },
        'sorry, 4 wigs for Ada not 3',
      );
      expect(await states(business.id)).toEqual(['superseded', 'pending']);

      await runRetriesNow(owner, business.id);
      await drain();
    });

    /* Nothing issued for that yes, and the unit its first attempt took is back. */
    expect((await footprint(business.id)).invoices).toBe(0);
    expect((await used(business.id)).documents).toBe(0);
    expect(stubSender.lastText).toBe(replies.previewAwaitingYes().text);

    /* The corrected preview is confirmed by the next yes, charged once. */
    await plain('wamid.G23-sup2-yes', 'yes');
    expect((await footprint(business.id)).invoices).toBe(1);
    expect((await used(business.id)).documents).toBe(1);
  });

  it('a yes queued behind a correction, retried, refunds nothing it never reserved', async () => {
    const business = await seedMerchant();
    /* One real sale, so the counter holds a unit a wrong refund would take. */
    await say('wamid.G23-q0', A_SALE, 'sold Ada 3 wigs for 300k');
    await plain('wamid.G23-q0-yes', 'yes');
    expect((await used(business.id)).documents).toBe(1);
    await say('wamid.G23-q1', A_SALE, 'sold Ada 3 more wigs for 300k');

    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      /* The yes's answer fails to be recorded once, so its job is retried.
       * Stored bodies are placeholders (G-136), so the answer is found by what
       * it replies to: the inbound row of the yes, by its provider id. */
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g23_ptr_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g23_fail_ptr_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM conversation_messages m
             WHERE m.id = NEW.reply_to_message_id
               AND m.business_id = NEW.business_id
               AND m.provider_message_id = 'wamid.G23-q2-yes'
          ) AND nextval('g23_ptr_once') = 1 THEN
            RAISE EXCEPTION 'g23: answer fails once';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g23_fail_ptr_once BEFORE INSERT ON conversation_messages
          FOR EACH ROW WHEN (NEW.direction = 'outbound' AND NEW.reply_to_message_id IS NOT NULL)
          EXECUTE FUNCTION g23_fail_ptr_once()`);

      /* The correction reaches Rekoda first, the yes after; both queue, and
       * the correction is handled (superseding the draft) after the yes had
       * already arrived. The yes meters nothing: there is nothing for it. */
      stubTransport.replyWith({
        ...A_SALE,
        items: [{ name: 'wig', quantity: 4, unitPrice: 100_000 }],
        statedTotal: 400_000,
      });
      await post(messagePayload('2348031234567', 'wamid.G23-q2', 'sorry, 4 wigs for Ada not 3'));
      await post(messagePayload('2348031234567', 'wamid.G23-q2-yes', 'yes'));
      await drain();
      await runRetriesNow(ownerDb, business.id);
      await drain();
      /* The injected failure happened, and the yes's answer was then recorded:
       * the sequence was drawn once for the failure and once for the retry. A
       * trigger that never matches would leave it undrawn and the test would
       * pass without retrying anything. */
      const drawn = await ownerDb.execute<{ last_value: string; is_called: boolean }>(
        sql`SELECT last_value, is_called FROM g23_ptr_once`,
      );
      expect(drawn[0]?.is_called).toBe(true);
      expect(Number(drawn[0]?.last_value)).toBe(2);
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g23_fail_ptr_once ON conversation_messages`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g23_fail_ptr_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g23_ptr_once`);
      await close();
    }

    expect(stubSender.lastText).toBe(replies.previewAwaitingYes().text);
    /* Still the one unit the real sale cost: nothing reserved, nothing back. */
    expect((await used(business.id)).documents).toBe(1);
    expect((await footprint(business.id)).invoices).toBe(1);
  });

  it('a lapsed clarification was never a preview: a later yes or no is not told it expired', async () => {
    const business = await seedMerchant();
    await say(
      'wamid.G23-unclear',
      { intent: 'Unclear', clarification: 'How many wigs?' },
      'sold some wigs',
    );
    expect(stubSender.lastText).toContain('How many wigs?');
    await lapse(business.id);

    await plain('wamid.G23-unclear-yes', 'yes');
    expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
    const before = stubSender.sent.length;
    await plain('wamid.G23-unclear-no', 'no');
    expect(stubSender.sent.slice(before).map((m) => m.text)).not.toContain(
      replies.expiredNothingToCancel().text,
    );
  });

  it('an expired erasure ask answered yes or no says nothing was deleted, never "saved"', async () => {
    const business = await seedMerchant();
    await plain('wamid.G23-ex-del', 'delete my data');
    await lapse(business.id);
    await plain('wamid.G23-ex-yes', 'yes');
    expect(stubSender.lastText).toBe(replies.erasureKept().text);
    await plain('wamid.G23-ex-no', 'no');
    expect(stubSender.lastText).toBe(replies.erasureKept().text);
    expect(await states(business.id)).toEqual(['expired']);
  });

  it('a second erasure ask after the first ask expired deletes nothing and asks again', async () => {
    const business = await seedMerchant();
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T9',
      [{ facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-g23-erase' }],
    );
    const facets = () =>
      withBusiness(db, business.id, (tx) =>
        customersRepo.identityFacetsFor(tx, business.id, customer.id),
      );

    await plain('wamid.G23-del1', 'delete my data');
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');
    await lapse(business.id);

    /* Too late to be the confirmation: it is a new first ask. */
    await plain('wamid.G23-del2', 'delete my data');
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');
    expect(await facets()).toHaveLength(1);
    expect(await states(business.id)).toEqual(['expired', 'pending']);

    /* Inside the new window, the exact phrase erases, as it always has. */
    await plain('wamid.G23-del3', 'delete my data');
    /* One more than the test seeds: seedMerchant records Ada (G-137), and erasure takes her name too. */
    expect(stubSender.lastText).toContain('deleted (2 records)');
    expect(await facets()).toEqual([]);
  });
});

/**
 * OD-58 (owner ruling, 21 Nov 2026): a correction whose preview never reached the merchant fails
 * closed. The replacement is unconfirmable, the draft it superseded stays superseded (only purchase
 * drafts are recorded for restoring), so a "yes" posts nothing, costs nothing, and is told nothing
 * waits for it; the merchant sends the request again.
 */
describe('a correction whose preview was not delivered fails closed (OD-58)', () => {
  const FOUR = {
    ...A_SALE,
    customer: { kind: 'none' },
    items: [{ name: 'wig', quantity: 4, unitPrice: 100_000 }],
    statedTotal: 400_000,
  };

  it('a late failure: neither the original nor the correction can be confirmed', async () => {
    const business = await seedMerchant();
    await say('wamid.OD58-late-sale', A_SALE, 'sold Ada 3 wigs for 300k');
    await say('wamid.OD58-late-fix', FOUR, 'No, 4 not 3');
    expect(stubSender.lastText).toContain('replaced the earlier version');
    const fix = lastWamid();
    expect(await states(business.id)).toEqual(['superseded', 'pending']);

    await receipt('2348031234567', fix, 'failed');
    await drain();
    const retired = await draftStates(business.id);
    expect(retired[0]?.state).toBe('superseded');
    expect(retired[0]?.reason).not.toBe('preview_not_delivered');
    expect(retired[1]).toEqual({ state: 'superseded', reason: 'preview_not_delivered' });
    /* Meta retries the receipt: nothing more changes. */
    await receipt('2348031234567', fix, 'failed');
    await drain();
    expect(await draftStates(business.id)).toEqual(retired);

    await plain('wamid.OD58-late-yes', 'yes');
    expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, payments: 0, postings: 0 });
    expect((await used(business.id)).documents).toBe(0);
  });

  it('a send that failed outright: the yes posts neither the correction nor the original', async () => {
    const business = await seedMerchant();
    await say('wamid.OD58-send-sale', A_SALE, 'sold Ada 3 wigs for 300k');
    stubSender.failWith();
    await say('wamid.OD58-send-fix', FOUR, 'No, 4 not 3');
    /* The original is not brought back: only purchase drafts are recorded for restoring. */
    expect(await states(business.id)).toEqual(['superseded', 'pending']);
    expect((await previewFlags(business.id)).map((f) => f.previewed)).toEqual([true, false]);

    await plain('wamid.OD58-send-yes', 'yes');
    expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, payments: 0, postings: 0 });
    expect((await used(business.id)).documents).toBe(0);
  });
});

/* CodeRabbit on #437 (PRRT_kwDOT845J8676qPh): a repeated yes never books a preview while a failed
 * receipt for the pointer in front of it ("a preview is waiting") is stored and not yet applied. */
const QUESTION = {
  intent: 'Query',
  topic: 'sales_summary',
  customer: null,
  period: 'today',
  periodText: 'today',
  format: 'chat',
};

/** A preview, a question after it, and a first yes answered with a pointer WhatsApp accepted. */
async function pointedAt(tag: string) {
  const business = await seedMerchantR();
  const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
  await sayR(
    `wamid.${tag}1`,
    sale({ kind: 'token', token: ada.token }),
    'sold Ada Obi 2 wigs for 100k',
  );
  await sayR(`wamid.${tag}2`, QUESTION, 'how much did I sell today');
  const answer = lastWamid();
  const before = await footprintR(business.id);
  await plainR(`wamid.${tag}3`, 'yes');
  expect(stubSender.lastText).toBe(replies.previewBehindQuestion().text);
  return { business, before, answer, pointer: lastWamid() };
}

const statesR = async (businessId: string) =>
  [
    ...(await withBusiness(db, businessId, (tx) =>
      tx.execute<{ intent: string; state: string }>(sql`
        SELECT intent, state FROM command_drafts
         WHERE business_id = ${businessId}::uuid ORDER BY insertion_seq`),
    )),
  ].map((r) => `${r.intent}:${r.state}`);
const BEHIND = [replies.previewBehindQuestion().text];

/* OD-75 Option A (owner ruling OWN-107): when the question's answer AND the pointer past it both fail,
 * in either order, the question still stands, so a repeated yes is pointed again and books nothing. */
describe('the answer to a question and the pointer past it both reported failed', () => {
  it.each(['answer first', 'pointer first'] as const)(
    '%s: the yes books nothing',
    async (order) => {
      const { business, before, answer, pointer } = await pointedAt(`DF${order.length}`);
      for (const wamid of order === 'answer first' ? [answer, pointer] : [pointer, answer]) {
        await receipt(OWNER, wamid, 'failed');
        await drainR();
      }
      await plainR(`wamid.DF${order.length}-yes`, 'yes');
      expect(stubSender.lastText).toBe(replies.previewBehindQuestion().text);
      expect(await footprintR(business.id)).toEqual(before);
      await plainR(`wamid.DF${order.length}-yes2`, 'yes');
      expect((await footprintR(business.id)).invoices).toBe(before.invoices + 1);
    },
  );
});
describe('a repeated yes and a failed receipt for the pointer reply (CodeRabbit on #437)', () => {
  /* The yes is answered with the pointer again and books nothing; the receipt then puts the question
   * back, so it takes the ordinary pointer and one more yes to book, exactly once. */
  it('a receipt stored after the second yes was queued: nothing booked, the question is back', async () => {
    const { business, before, pointer } = await pointedAt('RC1');

    await post(messagePayload(OWNER, 'wamid.RC1-yes2', 'yes'));
    await receipt(OWNER, pointer, 'failed');
    await drainR();

    expect(await footprintR(business.id)).toEqual(before);
    expect(await answered(business.id, 'RC1-yes2')).toEqual({ replies: [BEHIND], unfinished: 0 });
    expect(await statesR(business.id)).toEqual(['RecordSale:pending', 'Query:pending']);
  });

  it('afterwards the pointer and one more yes book the preview once', async () => {
    const { business, before, pointer } = await pointedAt('RC2');

    await post(messagePayload(OWNER, 'wamid.RC2-yes2', 'yes'));
    await receipt(OWNER, pointer, 'failed');
    await drainR();
    await plainR('wamid.RC2-yes3', 'yes');
    expect(stubSender.lastText).toBe(replies.previewBehindQuestion().text);
    expect(await footprintR(business.id)).toEqual(before);
    await plainR('wamid.RC2-yes4', 'yes');
    expect((await footprintR(business.id)).invoices).toBe(before.invoices + 1);
    await plainR('wamid.RC2-yes5', 'yes');
    expect((await footprintR(business.id)).invoices).toBe(before.invoices + 1);
  });

  it('a receipt applied before the second yes: nothing booked', async () => {
    const { business, before, pointer } = await pointedAt('RC3');

    await receipt(OWNER, pointer, 'failed');
    await drainR();
    await plainR('wamid.RC3-yes2', 'yes');

    expect(await footprintR(business.id)).toEqual(before);
    expect(stubSender.lastText).toBe(replies.previewBehindQuestion().text);
  });

  it('duplicate failed receipts change nothing more than one', async () => {
    const { business, before, pointer } = await pointedAt('RC4');

    await post(messagePayload(OWNER, 'wamid.RC4-yes2', 'yes'));
    await receipt(OWNER, pointer, 'failed');
    await receipt(OWNER, pointer, 'failed');
    await drainR();

    expect(await footprintR(business.id)).toEqual(before);
    expect(await statesR(business.id)).toEqual(['RecordSale:pending', 'Query:pending']);
  });

  it('a pointer WhatsApp accepted, no failure reported: the second yes books once', async () => {
    const { business, before } = await pointedAt('RC5');

    await post(messagePayload(OWNER, 'wamid.RC5-yes2', 'yes'));
    await drainR();

    expect((await footprintR(business.id)).invoices).toBe(before.invoices + 1);
  });

  it('two yeses queued with the receipt: neither books (without the fix the first one did)', async () => {
    const { business, before, pointer } = await pointedAt('RC6');

    await post(messagePayload(OWNER, 'wamid.RC6-yes2', 'yes'));
    await post(messagePayload(OWNER, 'wamid.RC6-yes3', 'yes'));
    await receipt(OWNER, pointer, 'failed');
    await drainR();

    expect(await footprintR(business.id)).toEqual(before);
    expect((await answered(business.id, 'RC6-yes2', 'RC6-yes3')).replies).toEqual([BEHIND, BEHIND]);
  });
});

/**
 * CodeRabbit on #437 (PRRT_kwDOT845J8676qPS): a preview withdrawn because an earlier message of
 * the merchant was lost keeps that fact when a failed receipt for the preview arrives later.
 *
 * Both are true and both are kept: the request was withdrawn (so a "yes" is told to send it
 * again, and books nothing) and its preview never reached the merchant (so it is no answer to
 * a refusal, `hasDraftsAfterBy`). Before, the receipt overwrote `inbound_message_failed` with
 * `preview_not_delivered` and the next "yes" lost the resend instruction.
 */
const OWNERF = '2348031234567';

describe('a failed receipt for a preview withdrawn behind a lost message', () => {
  it.each(['yes', 'no'] as const)(
    'keeps the resend guidance for a later "%s", books nothing, and a repeated receipt changes nothing',
    async (answer) => {
      const business = await seedMerchant();
      await say(`wamid.FI-${answer}-1`, AN_EXPENSE, 'bought fuel 20k cash');
      const preview = lastWamid();
      await queueOnly(`wamid.FI-${answer}-cancel`, 'cancel');
      await killInboundJob(business.id, 'markFailed');

      /* The lost message is reconciled first: the preview is withdrawn with the reason. */
      await plain(`wamid.FI-${answer}-2`, answer);
      const told =
        answer === 'yes' ? replies.earlierMessageLostYes() : replies.earlierMessageLostNo();
      expect(stubSender.lastText).toBe(told.text);

      /* WhatsApp then reports that preview undelivered, twice. */
      await receipt(OWNERF, preview, 'failed');
      await receipt(OWNERF, preview, 'failed');
      await drain();

      const states = await draftStates(business.id);
      expect(states).toEqual([{ state: 'superseded', reason: 'inbound_message_failed' }]);

      await plain(`wamid.FI-${answer}-3`, answer);
      expect(stubSender.lastText).toBe(told.text);
      await plain(`wamid.FI-${answer}-4`, 'yes');
      expect(stubSender.lastText).toBe(replies.earlierMessageLostYes().text);
      expect((await footprint(business.id)).expenses).toBe(0);
    },
  );

  /* The undelivered mark is what lets a refusal stay the member's last read: a withdrawn preview
   * that never arrived is not "recorded since" it (`hasDraftsAfterBy`). */
  it('still reads as undelivered by hasDraftsAfterBy once the receipt arrives', async () => {
    const business = await seedMerchant();
    await post(
      mediaMessage(
        'wamid.FI-ref',
        { type: 'sticker', sticker: { id: 's', mime_type: 'image/webp' } },
        OWNERF,
      ),
    );
    await drain();
    await say('wamid.FI-ref-1', AN_EXPENSE, 'bought fuel 20k cash');
    const preview = lastWamid();
    await queueOnly('wamid.FI-ref-cancel', 'cancel');
    await killInboundJob(business.id, 'markFailed');
    await plain('wamid.FI-ref-yes', 'yes');

    const owner = (await identity.upsertUserByPhone(db, `+${OWNERF}`)).id;
    const closes = () =>
      withBusiness(db, business.id, async (tx) => {
        const [refusal] = [
          ...(await tx.execute<{ id: string }>(sql`
            SELECT id FROM command_drafts
             WHERE business_id = ${business.id}::uuid AND command->>'refused' = 'true'
             ORDER BY insertion_seq LIMIT 1`)),
        ];
        return conversationsRepo.hasDraftsAfterBy(tx, business.id, refusal!.id, owner);
      });
    /* Withdrawn but possibly read: it still stands after the refusal. */
    expect(await closes()).toBe(true);
    await receipt(OWNERF, preview, 'failed');
    await drain();
    /* Reported undelivered: never read, so it no longer does. The reason is still the lost message. */
    expect(await closes()).toBe(false);
    expect(await draftStates(business.id)).toContainEqual({
      state: 'superseded',
      reason: 'inbound_message_failed',
    });
  });
});

/* Independent review of f605c98: the same race by the refusal route (a yes past the member's own refusal). */
describe('a repeated yes and a failed receipt for the refusal pointer', () => {
  it('books nothing while the receipt is stored, and the refusal is back once it runs', async () => {
    const business = await seedMerchantR();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await sayR(
      'wamid.RF1',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    await post(
      mediaMessage(
        'wamid.RF2',
        { type: 'sticker', sticker: { id: 's', mime_type: 'image/webp' } },
        OWNER,
      ),
    );
    await drainR();
    const before = await footprintR(business.id);
    await plainR('wamid.RF3', 'yes');
    expect(stubSender.lastText).toBe(replies.previewBehindRefusal().text);
    const pointer = lastWamid();

    await post(messagePayload(OWNER, 'wamid.RF4', 'yes'));
    await receipt(OWNER, pointer, 'failed');
    await drainR();

    expect(await footprintR(business.id)).toEqual(before);
    const behind = [replies.previewBehindRefusal().text];
    expect(await answered(business.id, 'RF4')).toEqual({ replies: [behind], unfinished: 0 });
    const refused = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ state: string }>(sql`
        SELECT state FROM command_drafts
         WHERE business_id = ${business.id}::uuid AND command->>'refused' = 'true'`),
    );
    expect([...refused].map((r) => r.state)).toEqual(['pending']);
  });
});

/* Independent review of f605c98: a spoken yes held by a stored pointer receipt is answered, never re-run. */
describe('a spoken yes held by a failed pointer receipt', () => {
  it('is transcribed once, books nothing, and is pointed again', async () => {
    const { business, before, pointer } = await pointedAt('RV');
    arrangeAudio(1);
    stubStt.answerWith({ text: 'yes', seconds: 1, confidence: 0.95 });

    await post(voicePayload(OWNER, 'wamid.RV-voice'));
    await receipt(OWNER, pointer, 'failed');
    await drainR();

    expect(stubStt.calls).toHaveLength(1);
    expect(await footprintR(business.id)).toEqual(before);
    expect(await answered(business.id, 'RV-voice')).toEqual({ replies: [BEHIND], unfinished: 0 });
  });
});
