/**
 * The command layer's idempotency record (canonical spec §26).
 *
 * One operation matters and it is the claim. `response_snapshot` is the
 * state, so the three answers a caller can get are the three states a row can
 * be in, and there is no fourth:
 *
 *   fresh      nobody had this key. You are the one running it.
 *   running    somebody else has it right now. Wait, do not run it twice.
 *   replay     it ran. Here is exactly what it answered.
 *
 * The middle one is the answer an ad-hoc key check always forgets. Two
 * identical requests arriving in the same second is the ORDINARY case for a
 * retrying client, and a design that only distinguishes "seen" from "unseen"
 * either runs both or tells the loser "done" with nothing in its hand.
 *
 * Nothing here decides what a command DOES. This is the record; the
 * dispatcher owns the meaning.
 */
import { sql } from 'drizzle-orm';
import type { TenantDb } from '../client.js';

export interface ClaimInput {
  businessId: string;
  key: string;
  commandName: string;
  /** A hash of the payload, so one key cannot answer for two requests. */
  requestHash: string;
}

export type Claim =
  /** You hold it. Run the command, then `complete` with what it answered. */
  | { readonly outcome: 'fresh'; readonly id: string }
  /** Somebody else holds it and has not finished. Do not run anything. */
  | { readonly outcome: 'running'; readonly since: Date }
  /** It finished. This is the first response, verbatim. */
  | { readonly outcome: 'replay'; readonly response: unknown; readonly completedAt: Date }
  /**
   * The key is in use for a DIFFERENT request.
   *
   * A refusal rather than a replay. A client that reuses one key for two
   * payloads has made a mistake, and handing back the first answer hides it
   * behind something plausible: the caller believes their second command ran
   * and it never did.
   */
  | { readonly outcome: 'key_reused'; readonly commandName: string };

/**
 * Take the key, or find out who has it.
 *
 * `ON CONFLICT DO NOTHING` rather than a read-then-write, so two requests
 * arriving together are separated by the unique index instead of by luck.
 * The loser reads the row the winner just wrote and is told which of the
 * three states it is in.
 */
export async function claim(tx: TenantDb, input: ClaimInput): Promise<Claim> {
  const taken = await tx.execute<{ id: string }>(sql`
    INSERT INTO idempotency_records (business_id, key, command_name, request_hash)
    VALUES (${input.businessId}::uuid, ${input.key}::text,
            ${input.commandName}::text, ${input.requestHash}::text)
    ON CONFLICT (business_id, key) DO NOTHING
    RETURNING id
  `);
  const fresh = [...taken][0];
  if (fresh) return { outcome: 'fresh', id: fresh.id };

  const existing = await tx.execute<{
    command_name: string;
    request_hash: string;
    response_snapshot: unknown;
    created_at: Date;
    completed_at: Date | null;
  }>(sql`
    SELECT command_name, request_hash, response_snapshot, created_at, completed_at
    FROM idempotency_records
    WHERE business_id = ${input.businessId}::uuid AND key = ${input.key}::text
  `);
  const row = [...existing][0];
  /* The row was there a microsecond ago and is not now. Only a rollback of
   * the transaction that wrote it can do that, which means nobody holds the
   * key: the caller should try again rather than be told a state that is no
   * longer true. */
  if (!row) return { outcome: 'running', since: new Date() };

  if (row.command_name !== input.commandName || row.request_hash !== input.requestHash) {
    return { outcome: 'key_reused', commandName: row.command_name };
  }

  if (row.completed_at === null) {
    return { outcome: 'running', since: new Date(row.created_at) };
  }
  return {
    outcome: 'replay',
    response: row.response_snapshot,
    completedAt: new Date(row.completed_at),
  };
}

/**
 * Write down what the command answered.
 *
 * In the SAME transaction as the state change it describes. A snapshot
 * committed beside a rolled back sale is a record of something that did not
 * happen, and the next retry would be handed it as though it had.
 *
 * The WHERE re-checks that the record is still unfinished, so a second
 * completion cannot overwrite the first answer with a different one.
 */
export async function complete(
  tx: TenantDb,
  input: { businessId: string; id: string; response: unknown; now?: Date },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE idempotency_records
    SET response_snapshot = ${JSON.stringify(input.response ?? null)}::jsonb,
        completed_at = ${(input.now ?? new Date()).toISOString()}::timestamptz
    WHERE id = ${input.id}::uuid
      AND business_id = ${input.businessId}::uuid
      AND completed_at IS NULL
    RETURNING id
  `);
  return [...rows].length === 1;
}

/**
 * What this key answered, if anything. For a caller that wants to look
 * without taking.
 */
export async function find(
  tx: TenantDb,
  businessId: string,
  key: string,
): Promise<{ commandName: string; response: unknown; completedAt: Date | null } | null> {
  const rows = await tx.execute<{
    command_name: string;
    response_snapshot: unknown;
    completed_at: Date | null;
  }>(sql`
    SELECT command_name, response_snapshot, completed_at
    FROM idempotency_records
    WHERE business_id = ${businessId}::uuid AND key = ${key}::text
  `);
  const row = [...rows][0];
  if (!row) return null;
  return {
    commandName: row.command_name,
    response: row.response_snapshot,
    completedAt: row.completed_at === null ? null : new Date(row.completed_at),
  };
}
