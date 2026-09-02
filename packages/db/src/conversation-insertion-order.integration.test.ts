/**
 * A transcript that reads in the order it was written (migration 0146).
 *
 * One inbound job runs inside ONE transaction: it records the merchant's
 * message, decides what to say, and records the reply. Both rows took
 * `created_at DEFAULT now()`, and `now()` is TRANSACTION START time, so both
 * carried the same instant. `messagesFor` ordered by that column alone, which
 * left PostgreSQL free to return either first, and it has returned the reply
 * first: the merchant's own words printed underneath the answer to them.
 *
 * Nothing was corrupted. Both rows are correct; only their order was
 * undefined, which is why this surfaced as one test failing at random rather
 * than as a bug report. These tests are the statement that it no longer can.
 *
 * The migration fixes rows written from now on. Rows written before it share
 * an instant with everything else their transaction wrote and always will, so
 * the readers also carry `id` as a tiebreaker: it cannot recover the true
 * order of those rows, but it makes every read of them agree with the last.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  conversationsRepo,
  createDb,
  identity,
  withBusiness,
  type Db,
  type TenantDb,
} from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

/**
 * The columns a reader sorts by. `column` is spelled into `label` because
 * vitest reads `$table.$column` in a title as a nested property path and
 * renders it undefined.
 */
const ORDERED_BY_INSERTION = [
  { label: 'conversation_messages.created_at', table: 'conversation_messages' },
  { label: 'command_drafts.created_at', table: 'command_drafts' },
] as const;

let urls: Urls;
let owner: Db;
let app: Db;
let closeOwner: () => Promise<void>;
let closeApp: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  const asOwner = createDb(urls.owner, { max: 2 });
  owner = asOwner.db;
  closeOwner = asOwner.close;
  const asApp = createDb(urls.app, { max: 4 });
  app = asApp.db;
  closeApp = asApp.close;
});

afterAll(async () => {
  await closeApp();
  await closeOwner();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(app, `+23481600${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(app, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

function defaultExpr(table: string, column = 'created_at'): Promise<string | undefined> {
  return owner
    .execute<{ expr: string }>(
      sql`
      SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid AND c.relname = ${table}
        JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
       WHERE a.attname = ${column}
    `,
    )
    .then((rows) => [...rows][0]?.expr);
}

describe('rows read back in the order they were written', () => {
  it.each(ORDERED_BY_INSERTION)('$label advances within a transaction', async ({ table }) => {
    expect(await defaultExpr(table)).toBe('clock_timestamp()');
  });

  it('command_drafts.updated_at moves with created_at, so no row predates itself', async () => {
    /* Not an ordering key — nothing sorts drafts by it. It moves because the
     * column beside it did: a `created_at` read from the wall clock is LATER
     * than an `updated_at` read at transaction start, and leaving the two on
     * different clocks would stamp every new draft as modified before it
     * existed. */
    expect(await defaultExpr('command_drafts', 'updated_at')).toBe('clock_timestamp()');

    const businessId = await seedBusiness();
    await withBusiness(app, businessId, async (tx: TenantDb) => {
      const message = await conversationsRepo.recordInbound(tx, {
        businessId,
        channel: 'meta',
        kind: 'text',
        body: 'sold 2 wrappers',
        providerMessageId: 'wamid.STAMP.1',
      });
      await conversationsRepo.recordDraft(tx, {
        businessId,
        conversationMessageId: message.id,
        intent: 'RecordSale',
        command: { kind: 'RecordSale' },
        model: null,
      });
    });
    const rows = await owner.execute<{ sane: boolean }>(sql`
      SELECT updated_at >= created_at AS sane FROM command_drafts
       WHERE business_id = ${businessId}::uuid`);
    expect([...rows][0]?.sane).toBe(true);
  });

  it('conversations.created_at keeps now(), because nothing sorts threads by it', async () => {
    /* The counter-example that shows the rule is about READERS, not about
     * timestamps in general. A thread is found by identity, never by
     * position in a list, so it has no order to get wrong. */
    expect(await defaultExpr('conversations')).toBe('now()');
  });

  it('the hazard the old default created, spelled out', async () => {
    /* Kept executable so the migration's premise is checkable rather than a
     * claim in a comment. Both statements run in one transaction; only one
     * of the two functions can tell them apart. */
    const rows = await owner.transaction(async (tx) => {
      await tx.execute(sql`
        CREATE TEMP TABLE stamped (n int, at_start timestamptz DEFAULT now(),
                                          at_insert timestamptz DEFAULT clock_timestamp())
        ON COMMIT DROP`);
      await tx.execute(sql`INSERT INTO stamped (n) VALUES (1)`);
      await tx.execute(sql`INSERT INTO stamped (n) VALUES (2)`);
      return tx.execute<{ starts: number; inserts: number }>(sql`
        SELECT count(DISTINCT at_start)::int AS starts,
               count(DISTINCT at_insert)::int AS inserts
          FROM stamped`);
    });
    const row = [...rows][0];
    expect(row?.starts, 'now() cannot separate two rows of one transaction').toBe(1);
    expect(row?.inserts, 'clock_timestamp() can').toBe(2);
  });

  it('an inbound message and its reply, written by one job, read in that order', async () => {
    const businessId = await seedBusiness();

    /* Exactly what the job runner does: `withBusiness` opens ONE transaction
     * and the handler records both halves of the exchange inside it. */
    await withBusiness(app, businessId, async (tx: TenantDb) => {
      await conversationsRepo.recordInbound(tx, {
        businessId,
        channel: 'meta',
        kind: 'voice',
        body: '[audio message]',
        providerMessageId: 'wamid.ORDER.1',
      });
      await conversationsRepo.recordOutbound(tx, {
        businessId,
        channel: 'meta',
        kind: 'text',
        body: 'I can read typed messages.',
      });
    });

    const messages = await withBusiness(app, businessId, (tx) =>
      conversationsRepo.messagesFor(tx, businessId),
    );
    expect(messages.map((m) => m.direction)).toEqual(['inbound', 'outbound']);
    expect(messages[0]?.body).toBe('[audio message]');

    /* Asserted on the column and not only on the order it produced, because
     * the order alone is not evidence: with the old default the two rows tie
     * and the `id` tiebreaker still resolves them, correctly about half the
     * time. A STRICT increase is false whenever the default regresses. */
    const stamps = await owner.execute<{ ordered: boolean }>(sql`
      SELECT (SELECT created_at FROM conversation_messages
               WHERE business_id = ${businessId}::uuid AND direction = 'inbound')
           < (SELECT created_at FROM conversation_messages
               WHERE business_id = ${businessId}::uuid AND direction = 'outbound') AS ordered`);
    expect([...stamps][0]?.ordered, 'the reply must be stamped after the message').toBe(true);
  });

  it('the same exchange reads the same way through the thread reader', async () => {
    const businessId = await seedBusiness();
    await withBusiness(app, businessId, async (tx: TenantDb) => {
      await conversationsRepo.recordInbound(tx, {
        businessId,
        channel: 'meta',
        kind: 'text',
        body: 'sold 2 wrappers',
        providerMessageId: 'wamid.ORDER.2',
      });
      await conversationsRepo.recordOutbound(tx, {
        businessId,
        channel: 'meta',
        kind: 'text',
        body: 'Recorded.',
      });
    });

    const messages = await withBusiness(app, businessId, (tx) =>
      conversationsRepo.messagesForThread(tx, {
        kind: 'MERCHANT',
        businessId,
        channel: 'meta',
      }),
    );
    expect(messages.map((m) => m.direction)).toEqual(['inbound', 'outbound']);
  });

  it('two drafts written in one transaction: the merchant confirms the newer one', async () => {
    const businessId = await seedBusiness();

    /* `pendingDraft` takes the newest by `created_at` and that draft is what
     * a "yes" confirms, so a tie here is a tie over which command runs. */
    await withBusiness(app, businessId, async (tx: TenantDb) => {
      const first = await conversationsRepo.recordInbound(tx, {
        businessId,
        channel: 'meta',
        kind: 'text',
        body: 'sold 2 wrappers',
        providerMessageId: 'wamid.DRAFT.1',
      });
      await conversationsRepo.recordDraft(tx, {
        businessId,
        conversationMessageId: first.id,
        intent: 'RecordSale',
        command: { kind: 'RecordSale', note: 'first' },
        model: null,
      });
      const second = await conversationsRepo.recordInbound(tx, {
        businessId,
        channel: 'meta',
        kind: 'text',
        body: 'no, 3 wrappers',
        providerMessageId: 'wamid.DRAFT.2',
      });
      await conversationsRepo.recordDraft(tx, {
        businessId,
        conversationMessageId: second.id,
        intent: 'RecordSale',
        command: { kind: 'RecordSale', note: 'second' },
        model: null,
      });
    });

    const pending = await withBusiness(app, businessId, (tx) =>
      conversationsRepo.pendingDraft(tx, businessId),
    );
    expect((pending?.command as { note: string } | undefined)?.note).toBe('second');

    /* Same reasoning as above: the column, not just the order it produced. */
    const stamps = await owner.execute<{ distinct: number }>(sql`
      SELECT count(DISTINCT created_at)::int AS distinct FROM command_drafts
       WHERE business_id = ${businessId}::uuid`);
    expect([...stamps][0]?.distinct, 'two drafts, two instants').toBe(2);

    const drafts = await withBusiness(app, businessId, (tx) =>
      conversationsRepo.draftsFor(tx, businessId),
    );
    expect(drafts.map((d) => (d.command as { note: string }).note)).toEqual(['first', 'second']);
  });

  it('rows that DO share an instant still read the same way after one is edited', async () => {
    const businessId = await seedBusiness();

    /* The tiebreaker's job, and the only way to keep testing it: every row
     * written before 0146 carries its transaction's start time, so ties
     * survive the migration and something has to resolve them the same way
     * every read.
     *
     * The edit is what makes the hazard visible rather than theoretical. An
     * UPDATE writes a new row version at the END of the heap, so a plain
     * sequential scan returns the edited row LAST — a tied transcript
     * reshuffles itself when a voice note's transcript arrives and
     * `setInboundBody` fills it in. `id` cannot recover the true order of
     * these rows and does not pretend to; it only keeps the answer stable.
     */
    const ids: string[] = [];
    await withBusiness(app, businessId, async (tx: TenantDb) => {
      for (const n of [1, 2, 3, 4, 5]) {
        const written = await conversationsRepo.recordInbound(tx, {
          businessId,
          channel: 'meta',
          kind: 'text',
          body: `message ${n}`,
          providerMessageId: `wamid.TIED.${n}`,
        });
        ids.push(written.id);
      }
    });
    await owner.execute(
      sql`UPDATE conversation_messages SET created_at = timestamptz '2026-01-01 00:00:00+00'
           WHERE business_id = ${businessId}::uuid`,
    );

    const read = async (): Promise<string[]> =>
      (
        await withBusiness(app, businessId, (tx) => conversationsRepo.messagesFor(tx, businessId))
      ).map((m) => m.id);

    const before = await read();
    expect(before).toHaveLength(5);

    const edited = ids[1];
    if (!edited) throw new Error('fixture recorded no second message');
    const applied = await withBusiness(app, businessId, (tx) =>
      conversationsRepo.setInboundBody(tx, businessId, edited, 'sold 2 wrappers'),
    );
    expect(applied).toBe(true);

    expect(await read()).toEqual(before);
  });
});
