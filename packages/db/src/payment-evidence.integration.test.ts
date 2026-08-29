/**
 * Payment evidence and payment truth, against real PostgreSQL (spec §6).
 *
 * PR-003 writes no application code: these tables have no writers and no
 * readers yet. What it does is fix permanent, hard-to-change shape on tables
 * that will hold financial trust, and the tests are therefore about the
 * SCHEMA rather than about behaviour. Adding revocation or idempotency later
 * means migrating a populated append-only table, which is exactly the
 * situation append-only makes expensive.
 *
 * The SQL here is deliberately raw. There is no repository to go through,
 * because writing one before PR-005 needs it would be inventing the writer
 * this PR says it does not have.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db, type TenantDb } from './client.js';
import { identity } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let app: Db;
let worker: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: app, close: closeApp } = createDb(urls.app, { max: 8 }));
  ({ db: worker, close: closeWorker } = createDb(urls.worker, { max: 4 }));
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(app, `+23482000${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(app, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** A payment to hang verifications on. Raw, for the same reason as above. */
async function seedPayment(businessId: string): Promise<string> {
  const rows = await withBusiness(app, businessId, (tx) =>
    tx.execute<{ id: string }>(sql`
      INSERT INTO payments (business_id, amount_k, method, source_type)
      VALUES (${businessId}::uuid, 45000, 'transfer', 'manual')
      RETURNING id
    `),
  );
  const id = [...rows][0]?.id;
  if (!id) throw new Error('no payment');
  return id;
}

const verify = (
  tx: TenantDb,
  businessId: string,
  paymentId: string,
  source = 'MERCHANT_ATTESTED',
) =>
  tx.execute<{ id: string }>(sql`
    INSERT INTO payment_verifications (business_id, payment_id, source)
    VALUES (${businessId}::uuid, ${paymentId}::uuid, ${source}::text)
    RETURNING id
  `);

/* ── the enum the spec draws a line under ───────────────────────────────── */

describe('what a verification may claim as its source', () => {
  it.each(['PROVIDER_VERIFIED', 'BANK_FEED_MATCH', 'MERCHANT_ATTESTED', 'MANUAL_RECONCILIATION'])(
    'accepts %s',
    async (source) => {
      const businessId = await seedBusiness();
      const paymentId = await seedPayment(businessId);
      await expect(
        withBusiness(app, businessId, (tx) => verify(tx, businessId, paymentId, source)),
      ).resolves.toBeDefined();
    },
  );

  /**
   * Spec §6.2. A verification event means some evidence or assertion
   * actually occurred; an event recording that nothing is known is a
   * contradiction in terms, and permitting it would let the remediation
   * queue look worked when it was not.
   */
  it('refuses LEGACY_PROVENANCE_UNKNOWN, which is a state and not a source', async () => {
    const businessId = await seedBusiness();
    const paymentId = await seedPayment(businessId);
    await expect(
      withBusiness(app, businessId, (tx) =>
        verify(tx, businessId, paymentId, 'LEGACY_PROVENANCE_UNKNOWN'),
      ),
    ).rejects.toThrow();
  });
});

/* ── append-only, in the database rather than by convention ─────────────── */

describe('the event tables are append-only', () => {
  it.each([
    ['payment_verifications', 'UPDATE payment_verifications SET reason = %L'],
    ['payment_verifications', 'DELETE FROM payment_verifications'],
  ])('refuses to let the application rewrite %s', async (_table, _statement) => {
    const businessId = await seedBusiness();
    const paymentId = await seedPayment(businessId);
    await withBusiness(app, businessId, (tx) => verify(tx, businessId, paymentId));

    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(sql`UPDATE payment_verifications SET reason = 'rewritten'`),
      ),
    ).rejects.toThrow();
    await expect(
      withBusiness(app, businessId, (tx) => tx.execute(sql`DELETE FROM payment_verifications`)),
    ).rejects.toThrow();
  });

  it('refuses the same on revocations', async () => {
    const businessId = await seedBusiness();
    const paymentId = await seedPayment(businessId);
    const rows = await withBusiness(app, businessId, (tx) => verify(tx, businessId, paymentId));
    const verificationId = [...rows][0]!.id;
    await withBusiness(app, businessId, (tx) =>
      tx.execute(sql`
        INSERT INTO payment_verification_revocations
          (business_id, verification_id, reason, actor_id)
        VALUES (${businessId}::uuid, ${verificationId}::uuid, 'wrong payment', 'user:ada')
      `),
    );
    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(sql`UPDATE payment_verification_revocations SET reason = 'changed'`),
      ),
    ).rejects.toThrow();
    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(sql`DELETE FROM payment_verification_revocations`),
      ),
    ).rejects.toThrow();
  });

  /* The claim keeps DELETE, and needs it: revoking deletes the claim in the
   * same transaction as the revocation event, which is what releases the
   * evidence so a corrected verification can take it. */
  it('lets the claim be deleted, because releasing evidence is how it works', async () => {
    const businessId = await seedBusiness();
    const paymentId = await seedPayment(businessId);
    const rows = await withBusiness(app, businessId, (tx) => verify(tx, businessId, paymentId));
    const verificationId = [...rows][0]!.id;
    await withBusiness(app, businessId, (tx) =>
      tx.execute(sql`
        INSERT INTO payment_verification_claims
          (business_id, verification_id, confirmation_event_id)
        VALUES (${businessId}::uuid, ${verificationId}::uuid, 'draft-1')
      `),
    );
    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(sql`DELETE FROM payment_verification_claims`),
      ),
    ).resolves.toBeDefined();
  });

  /* But never changed. A claim never changes what it claims; it exists or it
   * does not, which is the whole of its state. */
  it('never lets a claim be updated', async () => {
    const businessId = await seedBusiness();
    const paymentId = await seedPayment(businessId);
    const rows = await withBusiness(app, businessId, (tx) => verify(tx, businessId, paymentId));
    const verificationId = [...rows][0]!.id;
    await withBusiness(app, businessId, (tx) =>
      tx.execute(sql`
        INSERT INTO payment_verification_claims
          (business_id, verification_id, confirmation_event_id)
        VALUES (${businessId}::uuid, ${verificationId}::uuid, 'draft-1')
      `),
    );
    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(sql`UPDATE payment_verification_claims SET confirmation_event_id = 'draft-2'`),
      ),
    ).rejects.toThrow();
  });
});

/* ── the claim projection: one source, one payment ─────────────────────── */

describe('source idempotency (spec §6.5)', () => {
  const claimOn = async (businessId: string, verificationId: string, key: string, value: string) =>
    withBusiness(app, businessId, (tx) =>
      tx.execute(sql`
        INSERT INTO payment_verification_claims (business_id, verification_id, ${sql.raw(key)})
        VALUES (${businessId}::uuid, ${verificationId}::uuid, ${value})
      `),
    );

  async function twoVerifications(businessId: string): Promise<[string, string]> {
    const one = await seedPayment(businessId);
    const two = await seedPayment(businessId);
    const a = await withBusiness(app, businessId, (tx) => verify(tx, businessId, one));
    const b = await withBusiness(app, businessId, (tx) => verify(tx, businessId, two));
    return [[...a][0]!.id, [...b][0]!.id];
  }

  /**
   * The rule the whole table exists for. One externally authoritative source
   * verifies ONE Payment: a bank transaction settling several invoices is one
   * Payment with several allocations, never several Payments consuming the
   * same line, because the latter double-counts on any report that sums
   * payments.
   */
  it.each([
    ['financial_transaction_id', '11111111-1111-1111-1111-111111111111'],
    ['provider_source_identity', 'conn-1:txn-9'],
    ['confirmation_event_id', 'draft-77'],
  ])('lets %s verify only one payment', async (key, value) => {
    const businessId = await seedBusiness();
    const [first, second] = await twoVerifications(businessId);

    await expect(claimOn(businessId, first, key, value)).resolves.toBeDefined();
    await expect(claimOn(businessId, second, key, value)).rejects.toThrow();
  });

  /**
   * Two writers reaching for the same evidence at the same instant. The
   * unique index decides, not the order the application happened to read in:
   * without this, both believe they hold the bank line and a duplicate
   * verification is exactly as damaging as a corrupted one.
   */
  it.each([
    ['financial_transaction_id', '22222222-2222-2222-2222-222222222222'],
    ['provider_source_identity', 'conn-1:txn-race'],
    ['confirmation_event_id', 'draft-race'],
  ])('hands %s to exactly one of two simultaneous writers', async (key, value) => {
    const businessId = await seedBusiness();
    const [first, second] = await twoVerifications(businessId);

    const results = await Promise.allSettled([
      claimOn(businessId, first, key, value),
      claimOn(businessId, second, key, value),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  /**
   * Revoking DELETES the claim, releasing the evidence, which is what makes
   * §6.4's correction path work: the same bank line can then verify the
   * payment it actually belonged to.
   */
  it('releases the evidence when the claim is deleted', async () => {
    const businessId = await seedBusiness();
    const [first, second] = await twoVerifications(businessId);
    const line = '33333333-3333-3333-3333-333333333333';

    await claimOn(businessId, first, 'financial_transaction_id', line);
    await expect(claimOn(businessId, second, 'financial_transaction_id', line)).rejects.toThrow();

    await withBusiness(app, businessId, (tx) =>
      tx.execute(
        sql`DELETE FROM payment_verification_claims WHERE verification_id = ${first}::uuid`,
      ),
    );
    await expect(
      claimOn(businessId, second, 'financial_transaction_id', line),
    ).resolves.toBeDefined();
  });

  /* The four sources do not share a notion of sameness, so there is no global
   * uniqueness rule to fall back on: a claim names exactly one key. */
  it('refuses a claim with no key, and a claim with two', async () => {
    const businessId = await seedBusiness();
    const [first] = await twoVerifications(businessId);

    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO payment_verification_claims (business_id, verification_id)
          VALUES (${businessId}::uuid, ${first}::uuid)
        `),
      ),
    ).rejects.toThrow();

    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO payment_verification_claims
            (business_id, verification_id, confirmation_event_id, provider_source_identity)
          VALUES (${businessId}::uuid, ${first}::uuid, 'draft-1', 'conn-1:txn-1')
        `),
      ),
    ).rejects.toThrow();
  });

  /* One claim per verification, so the reconstruction below is a bijection
   * rather than a best effort. */
  it('gives one verification at most one claim', async () => {
    const businessId = await seedBusiness();
    const [first] = await twoVerifications(businessId);
    await claimOn(businessId, first, 'confirmation_event_id', 'draft-a');
    await expect(claimOn(businessId, first, 'confirmation_event_id', 'draft-b')).rejects.toThrow();
  });

  /* Uniqueness is per tenant. Two businesses may each hold their own bank
   * line with the same id without seeing one another at all. */
  it('scopes uniqueness to one business', async () => {
    const mine = await seedBusiness();
    const theirs = await seedBusiness();
    const line = '44444444-4444-4444-4444-444444444444';
    const [a] = await twoVerifications(mine);
    const [b] = await twoVerifications(theirs);

    await expect(claimOn(mine, a, 'financial_transaction_id', line)).resolves.toBeDefined();
    await expect(claimOn(theirs, b, 'financial_transaction_id', line)).resolves.toBeDefined();
  });
});

/**
 * Spec §6.5: the claim table is derivable from verifications minus
 * revocations. That directionality is what keeps the model honest, because it
 * means a projection that was rebuilt, corrupted or dropped costs no
 * financial truth.
 */
describe('the claim table is reconstructable', () => {
  it('matches verifications minus revocations exactly', async () => {
    const businessId = await seedBusiness();
    const kept = await seedPayment(businessId);
    const revoked = await seedPayment(businessId);

    const a = [...(await withBusiness(app, businessId, (tx) => verify(tx, businessId, kept)))][0]!
      .id;
    const b = [
      ...(await withBusiness(app, businessId, (tx) => verify(tx, businessId, revoked))),
    ][0]!.id;

    await withBusiness(app, businessId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO payment_verification_claims (business_id, verification_id, confirmation_event_id)
        VALUES (${businessId}::uuid, ${a}::uuid, 'draft-kept'),
               (${businessId}::uuid, ${b}::uuid, 'draft-revoked')
      `);
      /* Revoking: the event and the release, one transaction. */
      await tx.execute(sql`
        INSERT INTO payment_verification_revocations (business_id, verification_id, reason, actor_id)
        VALUES (${businessId}::uuid, ${b}::uuid, 'matched the wrong payment', 'user:ada')
      `);
      await tx.execute(
        sql`DELETE FROM payment_verification_claims WHERE verification_id = ${b}::uuid`,
      );
    });

    const live = await withBusiness(app, businessId, (tx) =>
      tx.execute<{ verification_id: string }>(
        sql`SELECT verification_id FROM payment_verification_claims ORDER BY verification_id`,
      ),
    );
    const rebuilt = await withBusiness(app, businessId, (tx) =>
      tx.execute<{ id: string }>(sql`
        SELECT v.id FROM payment_verifications v
        WHERE NOT EXISTS (
          SELECT 1 FROM payment_verification_revocations r WHERE r.verification_id = v.id)
        ORDER BY v.id
      `),
    );
    expect([...live].map((r) => r.verification_id)).toEqual([...rebuilt].map((r) => r.id));
  });

  /* And a revocation happens once. Revoking twice has no meaning, and the
   * second row would make that reconstruction ambiguous. */
  it('revokes a verification at most once', async () => {
    const businessId = await seedBusiness();
    const paymentId = await seedPayment(businessId);
    const id = [
      ...(await withBusiness(app, businessId, (tx) => verify(tx, businessId, paymentId))),
    ][0]!.id;

    const revoke = () =>
      withBusiness(app, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO payment_verification_revocations (business_id, verification_id, reason, actor_id)
          VALUES (${businessId}::uuid, ${id}::uuid, 'wrong', 'user:ada')
        `),
      );
    await expect(revoke()).resolves.toBeDefined();
    await expect(revoke()).rejects.toThrow();
  });

  /* §6.4 requires both, and a revocation with neither is an unexplained
   * withdrawal of trust, which is worse than the wrong match it corrects. */
  it.each([
    ["''", "'user:ada'"],
    ["'wrong payment'", "''"],
  ])('refuses a revocation with a blank reason or actor', async (reason, actor) => {
    const businessId = await seedBusiness();
    const paymentId = await seedPayment(businessId);
    const id = [
      ...(await withBusiness(app, businessId, (tx) => verify(tx, businessId, paymentId))),
    ][0]!.id;

    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(
          sql`INSERT INTO payment_verification_revocations (business_id, verification_id, reason, actor_id)
              VALUES (${businessId}::uuid, ${id}::uuid, ${sql.raw(reason)}, ${sql.raw(actor)})`,
        ),
      ),
    ).rejects.toThrow();
  });
});

/* ── tenant isolation, and the operator tables that have no tenant ──────── */

describe('who can see what', () => {
  it.each([
    'payment_evidence',
    'payment_verifications',
    'payment_verification_revocations',
    'payment_verification_claims',
  ])('keeps %s to its own tenant', async (table) => {
    const mine = await seedBusiness();
    const theirs = await seedBusiness();
    const paymentId = await seedPayment(mine);
    const id = [...(await withBusiness(app, mine, (tx) => verify(tx, mine, paymentId)))][0]!.id;
    await withBusiness(app, mine, async (tx) => {
      await tx.execute(sql`
        INSERT INTO payment_evidence (business_id, source) VALUES (${mine}::uuid, 'chat_image')`);
      await tx.execute(sql`
        INSERT INTO payment_verification_revocations (business_id, verification_id, reason, actor_id)
        VALUES (${mine}::uuid, ${id}::uuid, 'wrong', 'user:ada')`);
      await tx.execute(sql`
        INSERT INTO payment_verification_claims (business_id, verification_id, confirmation_event_id)
        VALUES (${mine}::uuid, ${id}::uuid, 'draft-1')`);
    });

    const seen = await withBusiness(app, theirs, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`),
    );
    expect([...seen][0]?.n).toBe(0);
  });

  /**
   * The manifests are operator infrastructure, not merchant data. A migration
   * spans every tenant, so they have no `business_id` and cannot honestly
   * wear tenant RLS; instead the application roles are granted nothing at
   * all. A merchant-facing service has no business reading a cross-tenant
   * migration record.
   */
  it.each(['migration_manifests', 'migration_manifest_items'])(
    'gives the application no access at all to %s',
    async (table) => {
      const businessId = await seedBusiness();
      await expect(
        withBusiness(app, businessId, (tx) =>
          tx.execute(sql`SELECT count(*) FROM ${sql.raw(table)}`),
        ),
      ).rejects.toThrow();
      await expect(worker.execute(sql`SELECT count(*) FROM ${sql.raw(table)}`)).rejects.toThrow();
    },
  );
});

/**
 * §23 keeps raw media and the financial record on different clocks. A
 * screenshot of somebody's bank app is personal data; the fact that a claim
 * was made is a financial record, and the claim survives the purge.
 */
describe('evidence retention', () => {
  it('starts unresolved with nothing resolved', async () => {
    const businessId = await seedBusiness();
    const rows = await withBusiness(app, businessId, (tx) =>
      tx.execute<{ resolution_state: string; resolved_at: Date | null }>(sql`
        INSERT INTO payment_evidence (business_id, source, media_ref, claimed_amount_k)
        VALUES (${businessId}::uuid, 'chat_image', 'r2://evidence/1', 45000)
        RETURNING resolution_state, resolved_at
      `),
    );
    expect([...rows][0]?.resolution_state).toBe('UNRESOLVED');
    expect([...rows][0]?.resolved_at).toBeNull();
  });

  /* Expiry sets `resolvedAt` too: the retention countdown starts from the
   * same instant whether the claim was settled or abandoned, and an abandoned
   * dispute is the MOST likely state for a claim to be in. */
  it.each(['RESOLVED', 'EXPIRED'])('requires a resolution time for %s', async (state) => {
    const businessId = await seedBusiness();
    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO payment_evidence (business_id, source, resolution_state)
          VALUES (${businessId}::uuid, 'chat_image', ${state})
        `),
      ),
    ).rejects.toThrow();

    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO payment_evidence (business_id, source, resolution_state, resolved_at)
          VALUES (${businessId}::uuid, 'chat_image', ${state}, now())
        `),
      ),
    ).resolves.toBeDefined();
  });

  it('lets the raw media be purged while the claim survives', async () => {
    const businessId = await seedBusiness();
    const rows = await withBusiness(app, businessId, (tx) =>
      tx.execute<{ id: string }>(sql`
        INSERT INTO payment_evidence (business_id, source, media_ref, claimed_amount_k,
                                      resolution_state, resolved_at)
        VALUES (${businessId}::uuid, 'chat_image', 'r2://evidence/2', 45000, 'EXPIRED', now())
        RETURNING id
      `),
    );
    const id = [...rows][0]!.id;
    const after = await withBusiness(app, businessId, (tx) =>
      tx.execute<{ media_ref: string | null; claimed_amount_k: string | number | null }>(sql`
        UPDATE payment_evidence SET media_ref = NULL, raw_purged_at = now()
        WHERE id = ${id}::uuid
        RETURNING media_ref, claimed_amount_k
      `),
    );
    expect([...after][0]?.media_ref).toBeNull();
    expect(Number([...after][0]?.claimed_amount_k)).toBe(45_000);
  });
});
