/**
 * The worker credential keeps only the writes its jobs make, and four application-credential
 * exposures are closed (OD-51 and the worker-privilege assessment; migration 0210).
 *
 * Every assertion runs on a live connection AS the role (the CI database authenticates by trust, so
 * each URL is its own role), with `app.business_id` pinned to the victim business where the attack
 * needs it: the pin is caller-settable, so it is never what stops these writes.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness } from '../client.js';
import type { Db } from '../client.js';
import {
  appDb,
  outcome,
  ownerDb,
  seedBusiness,
  usePlanWriterHarness,
  workerDb,
} from '../billing/plan-writer.fixtures.js';

usePlanWriterHarness();

const pinned = (db: Db, businessId: string, statement: ReturnType<typeof sql>) =>
  outcome(withBusiness(db, businessId, (tx) => tx.execute(statement)));
const DENIED = /42501.*permission denied/;

describe('0210: the worker cannot write tenant or identity data', () => {
  it.each([
    [
      'users',
      (b: string) =>
        sql`UPDATE users SET phone = '+2348000000000' WHERE id = (SELECT owner_user_id FROM businesses WHERE id = ${b}::uuid)`,
    ],
    [
      'sessions',
      (b: string) =>
        sql`INSERT INTO sessions (user_id, business_id, token_hash, expires_at) SELECT owner_user_id, id, 'forged', now() + interval '1 day' FROM businesses WHERE id = ${b}::uuid`,
    ],
    ['memberships', (b: string) => sql`DELETE FROM memberships WHERE business_id = ${b}::uuid`],
    ['businesses', (b: string) => sql`UPDATE businesses SET name = 'pwned' WHERE id = ${b}::uuid`],
    [
      'rekoda_migrations',
      () => sql`INSERT INTO rekoda_migrations (tag) VALUES ('9999_never_runs')`,
    ],
    [
      'business_entitlements',
      (b: string) =>
        sql`INSERT INTO business_entitlements (business_id, entitlement_key, source, granted_at) VALUES (${b}::uuid, 'REKODA_INTEGRATE', 'MANUAL_GRANT', now())`,
    ],
    [
      'ledger_entries',
      (b: string) =>
        sql`INSERT INTO ledger_entries (business_id, transaction_id, account_id, debit_k, credit_k) VALUES (${b}::uuid, gen_random_uuid(), gen_random_uuid(), 1, 0)`,
    ],
    ['invoices', (b: string) => sql`DELETE FROM invoices WHERE business_id = ${b}::uuid`],
    ['payments', (b: string) => sql`DELETE FROM payments WHERE business_id = ${b}::uuid`],
    [
      'jobs (insert)',
      (b: string) =>
        sql`INSERT INTO jobs (business_id, kind, payload) VALUES (${b}::uuid, 'billing.process', '{}'::jsonb)`,
    ],
    ['jobs (delete)', (b: string) => sql`DELETE FROM jobs WHERE business_id = ${b}::uuid`],
    [
      'subscription_charges',
      (b: string) =>
        sql`UPDATE subscription_charges SET checkout_url = 'x' WHERE business_id = ${b}::uuid`,
    ],
    ['usage_events', (b: string) => sql`DELETE FROM usage_events WHERE business_id = ${b}::uuid`],
  ])('%s', async (_table, statement) => {
    const victim = await seedBusiness();
    expect(await pinned(workerDb, victim, statement(victim))).toMatch(DENIED);
  });

  it('a table created after 0210 gives the worker no write by default', async () => {
    const name = `t_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await ownerDb.execute(sql.raw(`CREATE TABLE public.${name} (id int)`));
    try {
      const [row] = await ownerDb.execute<{ ins: boolean; sel: boolean }>(
        sql.raw(`SELECT has_table_privilege('rekoda_worker', 'public.${name}', 'INSERT') AS ins,
                        has_table_privilege('rekoda_worker', 'public.${name}', 'SELECT') AS sel`),
      );
      expect(row!.ins).toBe(false);
    } finally {
      await ownerDb.execute(sql.raw(`DROP TABLE public.${name}`));
    }
  });

  it('keeps exactly the writes its jobs make, at table and column level (0210, 0212)', async () => {
    const rows = await ownerDb.execute<{ grant: string }>(sql`
      SELECT c.relname || ':' || p.priv AS grant
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p(priv)
      WHERE n.nspname IN ('public', 'rekoda_private') AND c.relkind IN ('r', 'p')
        AND CASE WHEN p.priv IN ('INSERT', 'UPDATE')
                 THEN has_any_column_privilege('rekoda_worker', c.oid, p.priv)
                 ELSE has_table_privilege('rekoda_worker', c.oid, p.priv) END
      ORDER BY c.relname, p.priv`);
    expect([...rows].map((r) => r.grant)).toEqual([
      'audit_events:INSERT',
      'dead_job_exceptions:INSERT',
      'dead_job_exceptions:UPDATE',
      'external_events:UPDATE',
      'jobs:UPDATE',
      'outbox_events:UPDATE',
      'pending_object_deletions:DELETE',
      'pending_object_deletions:UPDATE',
      'reconciliations:INSERT',
      'stranger_contacts:INSERT',
      'stranger_contacts:UPDATE',
      'usage_counters:INSERT',
      'usage_counters:UPDATE',
      'webhook_deliveries:UPDATE',
      'webhook_endpoints:UPDATE',
    ]);
    const [defaults] = await ownerDb.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_default_acl d CROSS JOIN aclexplode(d.defaclacl) a
      WHERE a.grantee = 'rekoda_worker'::regrole
        AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')`);
    expect(defaults!.n).toBe(0);
  });

  it.each([
    ['kind', "kind = 'billing.process'"],
    ['payload', `payload = '{"eventId":"00000000-0000-0000-0000-000000000000"}'::jsonb`],
    ['business_id', 'business_id = gen_random_uuid()'],
  ])('cannot rewrite a job row to run other work (%s, 0212)', async (_column, set) => {
    const victim = await seedBusiness();
    await ownerDb.execute(
      sql`INSERT INTO jobs (business_id, kind, payload, state) VALUES (${victim}::uuid, 'document.render', '{}'::jsonb, 'done')`,
    );
    expect(
      await outcome(workerDb.execute(sql.raw(`UPDATE jobs SET ${set}, state = 'pending'`))),
    ).toMatch(DENIED);
  });

  it('queues a webhook delivery only as a copy of the outbox fact, for an endpoint of the same business (0212)', async () => {
    const mine = await seedBusiness();
    const theirs = await seedBusiness();
    const outboxId = randomUUID();
    const ownEndpoint = randomUUID();
    const foreignEndpoint = randomUUID();
    await ownerDb.execute(sql`
      INSERT INTO outbox_events (id, business_id, type, payload)
      VALUES (${outboxId}::uuid, ${mine}::uuid, 'invoice.issued', '{"invoice":"INV-1"}'::jsonb)`);
    for (const [id, business] of [
      [ownEndpoint, mine],
      [foreignEndpoint, theirs],
    ] as const) {
      await ownerDb.execute(sql`
        INSERT INTO webhook_endpoints (id, business_id, url, event_types, status, encrypted_secret)
        VALUES (${id}::uuid, ${business}::uuid, 'https://hooks.example.ng/x', ARRAY['*'], 'active', 'sealed')`);
    }
    // A forged delivery written directly is refused outright.
    expect(
      await pinned(
        workerDb,
        theirs,
        sql`INSERT INTO webhook_deliveries (business_id, endpoint_id, outbox_event_id, event_type, payload)
            VALUES (${theirs}::uuid, ${foreignEndpoint}::uuid, ${outboxId}::uuid, 'invoice.paid', '{"forged":true}'::jsonb)`,
      ),
    ).toMatch(DENIED);
    const queue = async (endpoint: string) =>
      [
        ...(await workerDb.execute<{ queued: boolean }>(
          sql`SELECT webhook_queue_delivery(${outboxId}::uuid, ${endpoint}::uuid) AS queued`,
        )),
      ][0]!.queued;
    // Another business's endpoint gets nothing; the business's own gets the fact, once.
    expect(await queue(foreignEndpoint)).toBe(false);
    expect(await queue(ownEndpoint)).toBe(true);
    expect(await queue(ownEndpoint)).toBe(false);
    const delivered = [
      ...(await ownerDb.execute<{ business_id: string; event_type: string; payload: unknown }>(sql`
        SELECT business_id, event_type, payload FROM webhook_deliveries WHERE outbox_event_id = ${outboxId}::uuid`)),
    ];
    expect(delivered).toEqual([
      { business_id: mine, event_type: 'invoice.issued', payload: { invoice: 'INV-1' } },
    ]);
  });
});

describe('0210: what the worker may do to an external event', () => {
  const event = async (opts: {
    businessId: string | null;
    provider?: string;
    processed?: boolean;
    error?: string | null;
  }) => {
    const id = randomUUID();
    await ownerDb.execute(sql`
      INSERT INTO external_events (id, business_id, provider, event_type, external_id, payload,
                                   signature_valid, processed_at, error)
      VALUES (${id}::uuid, ${opts.businessId}::uuid, ${opts.provider ?? 'paystack'}, 'charge.success',
              ${`ext-${id}`}, '{}'::jsonb, 1,
              ${opts.processed ? sql`now()` : sql`NULL`}, ${opts.error ?? null})`);
    return id;
  };
  const stateOf = async (id: string) =>
    [
      ...(await ownerDb.execute<{ processed: boolean; error: string | null }>(
        sql`SELECT processed_at IS NOT NULL AS processed, error FROM external_events WHERE id = ${id}::uuid`,
      )),
    ][0]!;
  const asWorker = (businessId: string | null, statement: ReturnType<typeof sql>) =>
    businessId ? pinned(workerDb, businessId, statement) : outcome(workerDb.execute(statement));

  it("cannot mark another business's payment event processed, even with the pin set to it", async () => {
    const victim = await seedBusiness();
    const id = await event({ businessId: victim });
    expect(
      await asWorker(
        victim,
        sql`UPDATE external_events SET processed_at = now(), error = NULL WHERE id = ${id}::uuid`,
      ),
    ).toMatch(/may only flag an attributed event/);
    expect(await stateOf(id)).toEqual({ processed: false, error: null });
  });

  it('cannot clear a flagged event or reopen a processed one', async () => {
    const victim = await seedBusiness();
    const flagged = await event({ businessId: victim, error: 'amount_mismatch' });
    expect(
      await asWorker(
        victim,
        sql`UPDATE external_events SET error = NULL WHERE id = ${flagged}::uuid`,
      ),
    ).toMatch(/may only flag an attributed event/);
    const processed = await event({ businessId: victim, processed: true });
    expect(
      await asWorker(
        victim,
        sql`UPDATE external_events SET processed_at = NULL WHERE id = ${processed}::uuid`,
      ),
    ).toMatch(/may only flag an attributed event/);
    expect(await stateOf(flagged)).toEqual({ processed: false, error: 'amount_mismatch' });
  });

  it('may add the dead-job flag to an unprocessed attributed event (OWN-73), and repeat it as a no-op', async () => {
    const owner = await seedBusiness();
    const id = await event({ businessId: owner });
    const flag = sql`UPDATE external_events SET error = COALESCE(error, 'payment_job_dead') WHERE id = ${id}::uuid AND processed_at IS NULL`;
    expect(await asWorker(owner, flag)).toBe('allowed');
    expect(await asWorker(owner, flag)).toBe('allowed');
    expect(await stateOf(id)).toEqual({ processed: false, error: 'payment_job_dead' });
  });

  it('marks an unattributed Paystack event processed only with a reason, so it stays flagged for operators', async () => {
    const silent = await event({ businessId: null });
    expect(
      await asWorker(
        null,
        sql`UPDATE external_events SET processed_at = now(), error = NULL WHERE id = ${silent}::uuid`,
      ),
    ).toMatch(/with a reason for a payment event/);
    expect(await stateOf(silent)).toEqual({ processed: false, error: null });
    expect(
      await asWorker(
        null,
        sql`UPDATE external_events SET processed_at = now(), error = 'unknown_reference' WHERE id = ${silent}::uuid`,
      ),
    ).toBe('allowed');
    // Once processed, never reopened or re-marked.
    expect(
      await asWorker(
        null,
        sql`UPDATE external_events SET processed_at = NULL, error = NULL WHERE id = ${silent}::uuid`,
      ),
    ).toMatch(/processed once/);
  });

  it('marks an unattributed WhatsApp event (a stranger) processed with no reason, as the stranger sweep does', async () => {
    const id = await event({ businessId: null, provider: 'meta' });
    expect(
      await asWorker(
        null,
        sql`UPDATE external_events SET processed_at = now(), error = NULL WHERE id = ${id}::uuid`,
      ),
    ).toBe('allowed');
  });
});

describe('0210: retention follows its own policy, never the caller', () => {
  const warned = async (businessId: string, ago: string) =>
    ownerDb.execute(sql`
      UPDATE businesses SET plan = 'expired', plan_expires_at = now() - ${ago}::interval,
        retention_notified_at = now() - ${ago}::interval
      WHERE id = ${businessId}::uuid`);
  const exists = async (businessId: string) =>
    [
      ...(await ownerDb.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM businesses WHERE id = ${businessId}::uuid`,
      )),
    ][0]!.n === 1;
  const remove = (businessId: string, cutoff: string) =>
    workerDb.execute<{ removed: number }>(
      sql`SELECT retention_delete_business(${businessId}::uuid, ${cutoff}::timestamptz) AS removed`,
    );

  it('a live trial, warned today, is not erased whatever cutoff the caller passes', async () => {
    const victim = await seedBusiness();
    await ownerDb.execute(
      sql`UPDATE businesses SET retention_notified_at = now() WHERE id = ${victim}::uuid`,
    );
    const [row] = await remove(victim, '2199-01-01T00:00:00Z');
    expect(Number(row!.removed)).toBe(-1);
    expect(await exists(victim)).toBe(true);
  });

  it('an expired business ended 10 days ago is not erased early by a far cutoff', async () => {
    const victim = await seedBusiness();
    await warned(victim, '40 days');
    await ownerDb.execute(
      sql`UPDATE businesses SET plan_expires_at = now() - interval '10 days' WHERE id = ${victim}::uuid`,
    );
    const [row] = await remove(victim, '2199-01-01T00:00:00Z');
    expect(Number(row!.removed)).toBe(-1);
    expect(await exists(victim)).toBe(true);
  });

  it('a business due under the policy is still erased', async () => {
    const due = await seedBusiness();
    await warned(due, '100 days');
    const [row] = await remove(due, new Date().toISOString());
    expect(Number(row!.removed)).toBeGreaterThan(0);
    expect(await exists(due)).toBe(false);
  });

  it('the unchecked deletion is not executable by any runtime role', async () => {
    const victim = await seedBusiness();
    for (const db of [workerDb, appDb]) {
      expect(
        await outcome(
          db.execute(
            sql`SELECT retention_delete_business_unchecked(${victim}::uuid, '2199-01-01'::timestamptz)`,
          ),
        ),
      ).toMatch(DENIED);
    }
  });

  it('a runtime role cannot backdate a retention notice to shorten the notice period', async () => {
    const victim = await seedBusiness();
    expect(
      await pinned(
        appDb,
        victim,
        sql`UPDATE businesses SET retention_notified_at = now() - interval '60 days' WHERE id = ${victim}::uuid`,
      ),
    ).toMatch(/never backdated/);
    // Stamping it now (the sweep's claim) and clearing it still work.
    expect(
      await pinned(
        appDb,
        victim,
        sql`UPDATE businesses SET retention_notified_at = now() WHERE id = ${victim}::uuid`,
      ),
    ).toBe('allowed');
    expect(
      await pinned(
        appDb,
        victim,
        sql`UPDATE businesses SET retention_notified_at = NULL WHERE id = ${victim}::uuid`,
      ),
    ).toBe('allowed');
  });
});

describe('0210: no runtime role writes the migration ledger or explicit entitlements', () => {
  it.each([
    ['rekoda_migrations', () => sql`INSERT INTO rekoda_migrations (tag) VALUES ('9999_skip_me')`],
    [
      'rekoda_migrations',
      () => sql`DELETE FROM rekoda_migrations WHERE tag = '0210_worker_least_privilege'`,
    ],
    [
      'business_entitlements',
      (b: string) =>
        sql`INSERT INTO business_entitlements (business_id, entitlement_key, source, granted_at) VALUES (${b}::uuid, 'REKODA_INTEGRATE', 'MANUAL_GRANT', now())`,
    ],
  ])('the application cannot write %s', async (_table, statement) => {
    const victim = await seedBusiness();
    expect(await pinned(appDb, victim, statement(victim))).toMatch(DENIED);
  });
});
