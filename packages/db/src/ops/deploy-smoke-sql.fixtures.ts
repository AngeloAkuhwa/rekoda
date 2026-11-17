/**
 * The harness for executing the staging pre-start database smoke (scripts/deploy-staging.sh,
 * SMOKE_0196_SQL) against a real migrated database, shared by the smoke suites.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll } from 'vitest';
import { sql, TransactionRollbackError } from 'drizzle-orm';
import { createDb, type Db } from '../client.js';
import { migrate, requireUrls } from '../testing.js';

const script = readFileSync(
  new URL('../../../../scripts/deploy-staging.sh', import.meta.url),
  'utf8',
);
export const SMOKE = /^SMOKE_0196_SQL="([\s\S]*?)"$/m.exec(script)?.[1];

let ownerDb: Db;
let close: () => Promise<void>;

export function useSmokeHarness(): void {
  beforeAll(async () => {
    const urls = requireUrls();
    await migrate(urls);
    ({ db: ownerDb, close } = createDb(urls.owner, { max: 1 }));
  });
  afterAll(async () => {
    await close?.();
  });
}

/** A migration file's text, for tamper cases that restore an earlier body. */
export const migrationText = (file: string): string =>
  readFileSync(new URL(`../../migrations/${file}`, import.meta.url), 'utf8');

/** The smoke's answer after `tamper`, inside a transaction that is always rolled back. The
 * harness-only fixture writer (never in a deployed database) is dropped first, as on staging. */
export async function smokeAfter(tamper: string): Promise<string> {
  let answer = '';
  await ownerDb
    .transaction(async (tx) => {
      await tx.execute(
        sql.raw('DROP FUNCTION IF EXISTS public.test_fixture_set_plan(uuid, text, timestamptz)'),
      );
      await tx.execute(
        sql.raw(
          'DROP FUNCTION IF EXISTS public.test_fixture_credit_bonus(uuid, text, text, integer)',
        ),
      );
      await tx.execute(
        sql.raw('DROP FUNCTION IF EXISTS public.test_fixture_start_grace(uuid, timestamptz)'),
      );
      if (tamper) await tx.execute(sql.raw(tamper));
      const [row] = await tx.execute<{ ok: boolean }>(
        sql.raw(`SELECT (${SMOKE!.replace(/^SELECT/, '')}) AS ok`),
      );
      answer = row?.ok ? 't' : 'f';
      tx.rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof TransactionRollbackError)) throw error;
    });
  return answer;
}
