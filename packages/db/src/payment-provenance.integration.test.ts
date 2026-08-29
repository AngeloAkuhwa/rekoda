/**
 * Provenance on payments, against real PostgreSQL (spec §6.2–6.3; PR-004).
 *
 * Two claims are being proven here, and both are database facts rather than
 * code review outcomes. First: `initial_confirmation_source` is set once, in
 * fact, for every writer that exists and every writer nobody has thought of.
 * Second: the one exemption is a named function with an owner, a grant and a
 * scope — not a flag, not a mode, and not reachable from any application
 * role by any path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { identity } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let app: Db;
let owner: Db;
let worker: Db;
let closeApp: () => Promise<void>;
let closeOwner: () => Promise<void>;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: app, close: closeApp } = createDb(urls.app, { max: 8 }));
  ({ db: owner, close: closeOwner } = createDb(urls.owner, { max: 4 }));
  ({ db: worker, close: closeWorker } = createDb(urls.worker, { max: 2 }));
});

afterAll(async () => {
  await closeApp?.();
  await closeOwner?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
  await owner.execute(sql`TRUNCATE rekoda_private.provenance_rollback_audit`);
  await owner.execute(sql`TRUNCATE migration_manifest_items, migration_manifests`);
});

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(app, `+23482100${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(app, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

async function seedPayment(businessId: string): Promise<string> {
  const rows = await withBusiness(app, businessId, (tx) =>
    tx.execute<{ id: string }>(sql`
      INSERT INTO payments (business_id, amount_k, method, source_type)
      VALUES (${businessId}::uuid, 45000, 'transfer', 'manual')
      RETURNING id
    `),
  );
  return [...rows][0]!.id;
}

const setSource = (businessId: string, paymentId: string, value: string | null) =>
  withBusiness(app, businessId, (tx) =>
    tx.execute(sql`
      UPDATE payments SET initial_confirmation_source = ${value}
      WHERE id = ${paymentId}::uuid
    `),
  );

const sourceOf = async (businessId: string, paymentId: string): Promise<string | null> => {
  const rows = await withBusiness(app, businessId, (tx) =>
    tx.execute<{ s: string | null }>(
      sql`SELECT initial_confirmation_source AS s FROM payments WHERE id = ${paymentId}::uuid`,
    ),
  );
  return [...rows][0]?.s ?? null;
};

/* ── the CHECKs ─────────────────────────────────────────────────────────── */

describe('what the columns accept', () => {
  it.each([
    'PROVIDER_VERIFIED',
    'BANK_FEED_MATCH',
    'MERCHANT_ATTESTED',
    'MANUAL_RECONCILIATION',
    'LEGACY_PROVENANCE_UNKNOWN',
  ])('accepts %s as an initial source', async (value) => {
    const businessId = await seedBusiness();
    const paymentId = await seedPayment(businessId);
    await expect(setSource(businessId, paymentId, value)).resolves.toBeDefined();
  });

  it('refuses a source nobody defined', async () => {
    const businessId = await seedBusiness();
    const paymentId = await seedPayment(businessId);
    await expect(setSource(businessId, paymentId, 'GUT_FEELING')).rejects.toThrow();
  });

  it.each(['CASH', 'BANK_TRANSFER', 'POS', 'CARD', 'USSD', 'WALLET', 'OTHER', 'UNKNOWN'])(
    'accepts %s as a method',
    async (value) => {
      const businessId = await seedBusiness();
      const paymentId = await seedPayment(businessId);
      await expect(
        withBusiness(app, businessId, (tx) =>
          tx.execute(
            sql`UPDATE payments SET payment_method = ${value} WHERE id = ${paymentId}::uuid`,
          ),
        ),
      ).resolves.toBeDefined();
    },
  );

  it('refuses a method nobody defined', async () => {
    const businessId = await seedBusiness();
    const paymentId = await seedPayment(businessId);
    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(sql`UPDATE payments SET payment_method = 'IOU' WHERE id = ${paymentId}::uuid`),
      ),
    ).rejects.toThrow();
  });
});

/* ── set once, in the database ──────────────────────────────────────────── */

describe('initial_confirmation_source is set once', () => {
  it('permits the first assignment', async () => {
    const businessId = await seedBusiness();
    const paymentId = await seedPayment(businessId);
    await setSource(businessId, paymentId, 'MERCHANT_ATTESTED');
    expect(await sourceOf(businessId, paymentId)).toBe('MERCHANT_ATTESTED');
  });

  it('refuses a second, different assignment', async () => {
    const businessId = await seedBusiness();
    const paymentId = await seedPayment(businessId);
    await setSource(businessId, paymentId, 'MERCHANT_ATTESTED');
    await expect(setSource(businessId, paymentId, 'PROVIDER_VERIFIED')).rejects.toThrow();
    expect(await sourceOf(businessId, paymentId)).toBe('MERCHANT_ATTESTED');
  });

  /* Remediation strengthens by APPENDING a verification. It cannot reach the
   * initial source, which is a fact about how the payment was born. */
  it('refuses an unset back to NULL, which is what a remediation script would try', async () => {
    const businessId = await seedBusiness();
    const paymentId = await seedPayment(businessId);
    await setSource(businessId, paymentId, 'LEGACY_PROVENANCE_UNKNOWN');
    await expect(setSource(businessId, paymentId, null)).rejects.toThrow();
  });

  /* Ordinary payment updates keep working: the trigger only wakes when the
   * provenance column itself moves. */
  it('leaves every other update on the row alone', async () => {
    const businessId = await seedBusiness();
    const paymentId = await seedPayment(businessId);
    await setSource(businessId, paymentId, 'MERCHANT_ATTESTED');
    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(
          sql`UPDATE payments SET status = 'confirmed', payment_method = 'CASH'
              WHERE id = ${paymentId}::uuid`,
        ),
      ),
    ).resolves.toBeDefined();
  });

  /**
   * The bypass test the plan demands: no session setting, GUC or flag
   * reachable from the application permits the change. A made-up
   * migration-mode GUC changes nothing, because the trigger consults the
   * ROLE and nothing else.
   */
  it('cannot be talked around with a session flag', async () => {
    const businessId = await seedBusiness();
    const paymentId = await seedPayment(businessId);
    await setSource(businessId, paymentId, 'MERCHANT_ATTESTED');
    await expect(
      withBusiness(app, businessId, async (tx) => {
        await tx.execute(sql`SET LOCAL rekoda.migration_mode = 'on'`);
        await tx.execute(sql`SET LOCAL app.bypass_immutability = 'true'`);
        await tx.execute(
          sql`UPDATE payments SET initial_confirmation_source = 'PROVIDER_VERIFIED'
              WHERE id = ${paymentId}::uuid`,
        );
      }),
    ).rejects.toThrow();
  });
});

/* ── the named exemption ────────────────────────────────────────────────── */

/** Build a COMPLETED manifest over the given payments, as the operator. */
async function seedManifest(
  items: Array<{
    businessId: string;
    paymentId: string;
    oldSource: string | null;
    newSource: string;
  }>,
): Promise<string> {
  const rows = await owner.execute<{ id: string }>(sql`
    INSERT INTO migration_manifests (name, cutoff_at, status, expected_row_count,
                                     affected_row_count, created_by, finished_at)
    VALUES ('r0a-backfill-test', now(), 'COMPLETED', ${items.length}, ${items.length},
            'operator:test', now())
    RETURNING id
  `);
  const manifestId = [...rows][0]!.id;
  for (const item of items) {
    await owner.execute(sql`
      INSERT INTO migration_manifest_items
        (manifest_id, business_id, payment_id, old_initial_source, new_initial_source)
      VALUES (${manifestId}::uuid, ${item.businessId}::uuid, ${item.paymentId}::uuid,
              ${item.oldSource}, ${item.newSource})
    `);
  }
  return manifestId;
}

const rollback = (manifestId: string, operator = 'operator:test', reason = 'approved rollback') =>
  owner.execute<{ rows_affected: number; rows_skipped: number; skipped_payment_ids: string[] }>(
    sql`SELECT * FROM rekoda_private.rollback_provenance_manifest(
          ${manifestId}::uuid, ${operator}, ${reason})`,
  );

describe('rollback_provenance_manifest', () => {
  it('is unreachable from the application roles, and callable by the operator', async () => {
    const businessId = await seedBusiness();
    const paymentId = await seedPayment(businessId);
    await setSource(businessId, paymentId, 'LEGACY_PROVENANCE_UNKNOWN');
    const manifestId = await seedManifest([
      { businessId, paymentId, oldSource: null, newSource: 'LEGACY_PROVENANCE_UNKNOWN' },
    ]);

    /* The app has no USAGE on the schema and no EXECUTE on the function:
     * it cannot even name the thing, let alone run it. */
    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(
          sql`SELECT * FROM rekoda_private.rollback_provenance_manifest(
                ${manifestId}::uuid, 'intruder', 'because')`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      worker.execute(
        sql`SELECT * FROM rekoda_private.rollback_provenance_manifest(
              ${manifestId}::uuid, 'intruder', 'because')`,
      ),
    ).rejects.toThrow();

    const result = await rollback(manifestId);
    expect([...result][0]).toMatchObject({ rows_affected: 1, rows_skipped: 0 });
    expect(await sourceOf(businessId, paymentId)).toBeNull();
  });

  /**
   * The skip is the part that matters. A merchant remediated this payment
   * after the migration ran, and a rollback that overwrote their correction
   * would be a second incident caused by fixing the first.
   */
  it('skips a row somebody corrected since, and says so', async () => {
    const businessId = await seedBusiness();
    const restored = await seedPayment(businessId);
    const remediated = await seedPayment(businessId);
    await setSource(businessId, restored, 'LEGACY_PROVENANCE_UNKNOWN');
    /* The remediated one was assigned LEGACY_... by the migration, then a
     * human established the truth. Simulated at the operator connection,
     * since set-once correctly stops the app doing this directly. */
    await owner.execute(sql`
      UPDATE payments SET initial_confirmation_source = NULL WHERE id = ${remediated}::uuid`);
    await owner.execute(sql`
      UPDATE payments SET initial_confirmation_source = 'MERCHANT_ATTESTED'
      WHERE id = ${remediated}::uuid`);

    const manifestId = await seedManifest([
      { businessId, paymentId: restored, oldSource: null, newSource: 'LEGACY_PROVENANCE_UNKNOWN' },
      {
        businessId,
        paymentId: remediated,
        oldSource: null,
        newSource: 'LEGACY_PROVENANCE_UNKNOWN',
      },
    ]);

    const result = [...(await rollback(manifestId))][0]!;
    expect(result.rows_affected).toBe(1);
    expect(result.rows_skipped).toBe(1);
    expect(result.skipped_payment_ids).toContain(remediated);

    expect(await sourceOf(businessId, restored)).toBeNull();
    /* The human's remediation survives the rollback intact. */
    expect(await sourceOf(businessId, remediated)).toBe('MERCHANT_ATTESTED');
  });

  it('touches nothing that belongs to another manifest', async () => {
    const businessId = await seedBusiness();
    const mine = await seedPayment(businessId);
    const theirs = await seedPayment(businessId);
    await setSource(businessId, mine, 'LEGACY_PROVENANCE_UNKNOWN');
    await setSource(businessId, theirs, 'LEGACY_PROVENANCE_UNKNOWN');

    const manifestId = await seedManifest([
      { businessId, paymentId: mine, oldSource: null, newSource: 'LEGACY_PROVENANCE_UNKNOWN' },
    ]);
    await seedManifest([
      { businessId, paymentId: theirs, oldSource: null, newSource: 'LEGACY_PROVENANCE_UNKNOWN' },
    ]);

    await rollback(manifestId);
    expect(await sourceOf(businessId, mine)).toBeNull();
    expect(await sourceOf(businessId, theirs)).toBe('LEGACY_PROVENANCE_UNKNOWN');
  });

  it('refuses a manifest that is not COMPLETED, and one that does not exist', async () => {
    const rows = await owner.execute<{ id: string }>(sql`
      INSERT INTO migration_manifests (name, cutoff_at, status, created_by)
      VALUES ('still-running', now(), 'RUNNING', 'operator:test')
      RETURNING id
    `);
    await expect(rollback([...rows][0]!.id)).rejects.toThrow();
    await expect(rollback('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
  });

  it('refuses a blank operator or reason', async () => {
    const businessId = await seedBusiness();
    const paymentId = await seedPayment(businessId);
    await setSource(businessId, paymentId, 'LEGACY_PROVENANCE_UNKNOWN');
    const manifestId = await seedManifest([
      { businessId, paymentId, oldSource: null, newSource: 'LEGACY_PROVENANCE_UNKNOWN' },
    ]);
    await expect(rollback(manifestId, '  ', 'reason')).rejects.toThrow();
    await expect(rollback(manifestId, 'operator:test', '')).rejects.toThrow();
    /* And neither refused call moved anything. */
    expect(await sourceOf(businessId, paymentId)).toBe('LEGACY_PROVENANCE_UNKNOWN');
  });

  /**
   * Rollback appends state; it never deletes the record of what happened.
   * The manifest survives marked ROLLED_BACK, its items survive untouched,
   * the migration's verifications survive revoked rather than erased, and
   * their claims are released so the evidence is free again.
   */
  it('appends, revokes and releases; deletes nothing', async () => {
    const businessId = await seedBusiness();
    const paymentId = await seedPayment(businessId);
    await setSource(businessId, paymentId, 'LEGACY_PROVENANCE_UNKNOWN');

    /* A verification the migration would have written, with its claim. */
    const v = await owner.execute<{ id: string }>(sql`
      INSERT INTO payment_verifications
        (business_id, payment_id, source, source_migration)
      VALUES (${businessId}::uuid, ${paymentId}::uuid, 'MANUAL_RECONCILIATION', 'r0a-backfill-test')
      RETURNING id
    `);
    const verificationId = [...v][0]!.id;
    await owner.execute(sql`
      INSERT INTO payment_verification_claims
        (business_id, verification_id, confirmation_event_id)
      VALUES (${businessId}::uuid, ${verificationId}::uuid, 'migration:r0a-test')
    `);

    const rows = await owner.execute<{ id: string }>(sql`
      INSERT INTO migration_manifests (name, cutoff_at, status, created_by, finished_at)
      VALUES ('r0a-backfill-test', now(), 'COMPLETED', 'operator:test', now())
      RETURNING id
    `);
    const manifestId = [...rows][0]!.id;
    await owner.execute(sql`
      INSERT INTO migration_manifest_items
        (manifest_id, business_id, payment_id, old_initial_source, new_initial_source,
         verification_id)
      VALUES (${manifestId}::uuid, ${businessId}::uuid, ${paymentId}::uuid,
              NULL, 'LEGACY_PROVENANCE_UNKNOWN', ${verificationId}::uuid)
    `);

    await rollback(manifestId, 'operator:ada', 'report was wrong about this cohort');

    const manifest = [
      ...(await owner.execute<{ status: string; rolled_back_by: string | null }>(
        sql`SELECT status, rolled_back_by FROM migration_manifests WHERE id = ${manifestId}::uuid`,
      )),
    ][0]!;
    expect(manifest.status).toBe('ROLLED_BACK');
    expect(manifest.rolled_back_by).toBe('operator:ada');

    const counts = [
      ...(await owner.execute<{
        items: number;
        verifications: number;
        revocations: number;
        claims: number;
      }>(sql`
        SELECT
          (SELECT count(*)::int FROM migration_manifest_items
            WHERE manifest_id = ${manifestId}::uuid)                          AS items,
          (SELECT count(*)::int FROM payment_verifications
            WHERE id = ${verificationId}::uuid)                               AS verifications,
          (SELECT count(*)::int FROM payment_verification_revocations
            WHERE verification_id = ${verificationId}::uuid)                  AS revocations,
          (SELECT count(*)::int FROM payment_verification_claims
            WHERE verification_id = ${verificationId}::uuid)                  AS claims
      `)),
    ][0]!;
    expect(counts).toEqual({ items: 1, verifications: 1, revocations: 1, claims: 0 });

    /* And a second rollback of the same manifest is refused: it is no longer
     * COMPLETED, which is the idempotency the status machine provides. */
    await expect(rollback(manifestId)).rejects.toThrow();
  });

  it('writes its own audit row, naming the operator and the counts', async () => {
    const businessId = await seedBusiness();
    const paymentId = await seedPayment(businessId);
    await setSource(businessId, paymentId, 'LEGACY_PROVENANCE_UNKNOWN');
    const manifestId = await seedManifest([
      { businessId, paymentId, oldSource: null, newSource: 'LEGACY_PROVENANCE_UNKNOWN' },
    ]);

    await rollback(manifestId, 'operator:ada', 'approved rollback');

    const audit = [
      ...(await owner.execute<{
        operator: string;
        reason: string;
        rows_affected: number;
        rows_skipped: number;
      }>(sql`
        SELECT operator, reason, rows_affected, rows_skipped
        FROM rekoda_private.provenance_rollback_audit
        WHERE manifest_id = ${manifestId}::uuid
      `)),
    ][0];
    expect(audit).toEqual({
      operator: 'operator:ada',
      reason: 'approved rollback',
      rows_affected: 1,
      rows_skipped: 0,
    });
  });

  /**
   * The search-path test. A caller with a temporary table shadowing
   * `payments` cannot redirect what the function resolves: `pg_temp` is
   * LAST on the function's fixed search_path and every reference is
   * schema-qualified, so the real table is the one that changes.
   */
  it('cannot be redirected by a shadowing temporary table', async () => {
    const businessId = await seedBusiness();
    const paymentId = await seedPayment(businessId);
    await setSource(businessId, paymentId, 'LEGACY_PROVENANCE_UNKNOWN');
    const manifestId = await seedManifest([
      { businessId, paymentId, oldSource: null, newSource: 'LEGACY_PROVENANCE_UNKNOWN' },
    ]);

    /* One session: create the shadow, then call the function inside it. */
    await owner.execute(sql`
      CREATE TEMP TABLE payments (id uuid, initial_confirmation_source text)
    `);
    try {
      await owner.execute(sql`
        INSERT INTO pg_temp.payments VALUES (${paymentId}::uuid, 'SHADOW')
      `);
      await owner.execute(
        sql`SELECT * FROM rekoda_private.rollback_provenance_manifest(
              ${manifestId}::uuid, 'operator:test', 'shadow test')`,
      );
    } finally {
      await owner.execute(sql`DROP TABLE IF EXISTS pg_temp.payments`);
    }

    /* The REAL row was restored; the shadow changed nothing. */
    expect(await sourceOf(businessId, paymentId)).toBeNull();
  });
});
