/**
 * The tenant-composite foreign keys, group F part one: the conversation thread.
 *
 * Ruling 1's thirty-four closed in 0132 through 0140. Asking that audit's own
 * question of the FINISHED schema found fourteen more relationships of exactly
 * the same shape it had missed; this is the first two of them, and they form a
 * chain: a message belongs to a thread, a draft belongs to the message that
 * proposed it.
 *
 * What was at stake is worse than an ordinary child row. The thread is the
 * transcript a merchant reads, and the draft is what they are asked to confirm
 * before money moves. Neither edge said whose parent it was.
 *
 * Run on the OWNER credential and outside row-level security, for the reason
 * the earlier groups give: RLS would refuse the cross-tenant write on its own,
 * so these tests would pass with no foreign keys at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client.js';
import { identity } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let owner: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  const created = createDb(urls.owner, { max: 2 });
  owner = created.db;
  close = created.close;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await truncateAll(urls);
});

interface Edge {
  readonly edge: string;
  readonly child: string;
  readonly column: string;
  readonly parent: string;
  readonly constraint: string;
}

const GROUP_F1: readonly Edge[] = [
  {
    edge: 'conversation_messages.conversation_id -> conversations',
    child: 'conversation_messages',
    column: 'conversation_id',
    parent: 'conversations',
    constraint: 'conversation_messages_conversation_business_fk',
  },
  {
    edge: 'command_drafts.conversation_message_id -> conversation_messages',
    child: 'command_drafts',
    column: 'conversation_message_id',
    parent: 'conversation_messages',
    constraint: 'command_drafts_message_business_fk',
  },
];

/** The parents that had to gain a tenant key before the edges could point at them. */
const NEW_UNIQUES = [
  { label: 'conversations', table: 'conversations', name: 'conversations_business_id_ux' },
  {
    label: 'conversation_messages',
    table: 'conversation_messages',
    name: 'conversation_messages_business_id_ux',
  },
] as const;

describe('group F1: the keys are declared as ruling 1 asked', () => {
  it.each(GROUP_F1)(
    '$edge: a validated composite key',
    async ({ child, column, parent, constraint }) => {
      const rows = await owner.execute<{ def: string; validated: boolean }>(sql`
        SELECT pg_get_constraintdef(con.oid) AS def, con.convalidated AS validated
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
         WHERE c.relname = ${child} AND con.conname = ${constraint}
      `);
      const row = [...rows][0];
      expect(row?.def).toBe(
        `FOREIGN KEY (business_id, ${column}) REFERENCES ${parent}(business_id, id)`,
      );
      expect(row?.validated).toBe(true);
    },
  );

  it.each(GROUP_F1)('$edge: the weaker single-column key is gone', async ({ child, column }) => {
    const rows = await owner.execute<{ conname: string }>(sql`
      SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = con.conkey[1]
       WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1
         AND c.relname = ${child} AND a.attname = ${column}
    `);
    expect([...rows].map((r) => r.conname)).toEqual([]);
  });

  it.each(NEW_UNIQUES)(
    '$label gains the tenant key the edges point at',
    async ({ table, name }) => {
      const rows = await owner.execute<{ def: string }>(sql`
      SELECT pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
       WHERE c.relname = ${table} AND con.conname = ${name}
    `);

      /* A composite foreign key needs a matching unique on the parent. Neither
       * of these had one, which is why the chain could not have been closed
       * without adding them first. */
      expect([...rows][0]?.def).toBe('UNIQUE (business_id, id)');
    },
  );

  it('leaves both reference columns NOT NULL, so neither key is ever skipped', async () => {
    const rows = await owner.execute<{ col: string; notnull: boolean }>(sql`
      SELECT c.relname || '.' || a.attname AS col, a.attnotnull AS notnull
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
       WHERE (c.relname = 'conversation_messages' AND a.attname = 'conversation_id')
          OR (c.relname = 'command_drafts' AND a.attname = 'conversation_message_id')
       ORDER BY 1
    `);

    /* MATCH SIMPLE skips a constraint when any key column is null. Both of
     * these are NOT NULL, and business_id is too, so there is no shape here
     * the database declines to check. Asserted rather than assumed, because
     * making either nullable later would quietly reopen the gap. */
    expect([...rows]).toEqual([
      { col: 'command_drafts.conversation_message_id', notnull: true },
      { col: 'conversation_messages.conversation_id', notnull: true },
    ]);
  });
});

/** One merchant with a thread, a message on it, and a draft from that message. */
async function seedCast(tag: string): Promise<Record<string, string>> {
  const user = await identity.upsertUserByPhone(owner, `+23487${tag.padStart(8, '0')}`);
  const business = await identity.createBusinessWithOwner(owner, {
    name: `Thread ${tag}`,
    businessType: null,
    ownerUserId: user.id,
  });
  const b = business.id;

  const one = async (statement: ReturnType<typeof sql>): Promise<string> => {
    const rows = await owner.execute<{ id: string }>(statement);
    const id = [...rows][0]?.id;
    if (!id) throw new Error('fixture insert returned no id');
    return id;
  };

  const conversation = await one(sql`
    INSERT INTO conversations (business_id, channel, conversation_kind, status)
    VALUES (${b}::uuid, 'whatsapp', 'MERCHANT', 'open') RETURNING id`);
  const asked = await one(sql`
    INSERT INTO conversation_messages (business_id, conversation_id, direction, kind)
    VALUES (${b}::uuid, ${conversation}::uuid, 'inbound', 'text') RETURNING id`);
  const draft = await one(sql`
    INSERT INTO command_drafts (business_id, conversation_message_id, intent, command, state)
    VALUES (${b}::uuid, ${asked}::uuid, 'RecordSale', '{}'::jsonb, 'pending') RETURNING id`);
  /* A second message carrying no draft. `command_drafts_message_ux` allows one
   * draft per message, so aiming the cross-tenant UPDATE at a message that
   * already has its own draft would trip that unique first and prove nothing
   * about the tenant. This is the message the edge tests point at. */
  const spare = await one(sql`
    INSERT INTO conversation_messages (business_id, conversation_id, direction, kind)
    VALUES (${b}::uuid, ${conversation}::uuid, 'outbound', 'text') RETURNING id`);

  return {
    conversations: conversation,
    conversation_messages: spare,
    command_drafts: draft,
  };
}

describe('group F1: the refusal is the database’s, not the application’s', () => {
  it.each(GROUP_F1)(
    '$edge: cannot be repointed at another tenant’s row',
    async ({ child, column, parent, constraint }) => {
      const mine = await seedCast('1');
      const theirs = await seedCast('2');

      /* Same tenant first: a constraint that refused everything would pass the
       * cross-tenant case and prove nothing. */
      await expect(
        owner.execute(
          sql.raw(`UPDATE ${child} SET ${column} = '${mine[parent]}' WHERE id = '${mine[child]}'`),
        ),
      ).resolves.toBeDefined();

      const refusal = await owner
        .execute(
          sql.raw(
            `UPDATE ${child} SET ${column} = '${theirs[parent]}' WHERE id = '${mine[child]}'`,
          ),
        )
        .then(
          () => null,
          (error: Error & { cause?: unknown }) => error,
        );

      expect(refusal, `${child}.${column} accepted another tenant's ${parent}`).not.toBeNull();
      expect(String(refusal?.cause)).toContain(constraint);
    },
  );

  it('a draft cannot be filed under a message that never existed', async () => {
    const mine = await seedCast('3');

    /* The chain matters more than either link. A draft naming a fabricated
     * message would be a confirmation prompt with no provenance at all. */
    const refusal = await owner
      .execute(
        sql.raw(`UPDATE command_drafts
                    SET conversation_message_id = '00000000-0000-4000-8000-000000000000'
                  WHERE id = '${mine['command_drafts']}'`),
      )
      .then(
        () => null,
        (error: Error & { cause?: unknown }) => error,
      );

    expect(refusal).not.toBeNull();
    expect(String(refusal?.cause)).toContain('command_drafts_message_business_fk');
  });
});
