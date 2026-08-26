/**
 * The evidence clocks against real PostgreSQL (spec §23; PR-011).
 *
 * The slice's own test clause: every published retention period has a sweep
 * that enforces it. These are the enforcement halves for the two evidence
 * periods; the page half is asserted where the page lives.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { evidenceResolutionDeadline, RETENTION, retentionCutoff } from '@rekoda/core';
import { createDb, withBusiness, type Db } from './client.js';
import { evidenceRetentionRepo, identity } from './index.js';
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
  const user = await identity.upsertUserByPhone(app, `+23482200${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(app, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

async function seedEvidence(
  businessId: string,
  over: { deadline?: Date | null; state?: string; resolvedAt?: Date | null; media?: string | null },
): Promise<string> {
  const rows = await withBusiness(app, businessId, (tx) =>
    tx.execute<{ id: string }>(sql`
      INSERT INTO payment_evidence
        (business_id, source, media_ref, media_mime_type, claimed_amount_k,
         resolution_deadline, resolution_state, resolved_at)
      VALUES (${businessId}::uuid, 'chat_image',
              ${over.media === null ? null : (over.media ?? 'r2://evidence/x')},
              'image/jpeg', 45000,
              ${over.deadline === null ? null : (over.deadline ?? new Date()).toISOString()},
              ${over.state ?? 'UNRESOLVED'},
              ${over.resolvedAt ? over.resolvedAt.toISOString() : null})
      RETURNING id
    `),
  );
  return [...rows][0]!.id;
}

const HOURS = 3_600_000;
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * HOURS);

describe('expiry: an unresolved claim must not live forever', () => {
  it('finds a claim past its deadline and expires it, stamping resolvedAt', async () => {
    const businessId = await seedBusiness();
    const id = await seedEvidence(businessId, { deadline: daysAgo(1) });

    const due = await evidenceRetentionRepo.dueForExpiry(worker, new Date());
    expect(due).toEqual([{ businessId, evidenceId: id }]);

    const expired = await withBusiness(app, businessId, (tx) =>
      evidenceRetentionRepo.expireEvidence(tx, businessId, [id]),
    );
    expect(expired).toBe(1);

    const row = await withBusiness(app, businessId, (tx) =>
      tx.execute<{ resolution_state: string; resolved_at: Date | null }>(
        sql`SELECT resolution_state, resolved_at FROM payment_evidence WHERE id = ${id}::uuid`,
      ),
    );
    expect([...row][0]?.resolution_state).toBe('EXPIRED');
    expect([...row][0]?.resolved_at).not.toBeNull();
  });

  it('never touches a claim before its deadline, or one with no deadline', async () => {
    const businessId = await seedBusiness();
    await seedEvidence(businessId, { deadline: new Date(Date.now() + 24 * HOURS) });
    /* NULL deadline: nothing was promised, and expiring it would invent a
     * schedule the page never published. */
    await seedEvidence(businessId, { deadline: null });

    expect(await evidenceRetentionRepo.dueForExpiry(worker, new Date())).toEqual([]);
  });

  it('is suspended by an active hold, and resumed by its release', async () => {
    const businessId = await seedBusiness();
    const id = await seedEvidence(businessId, { deadline: daysAgo(1) });
    const { holdId } = await withBusiness(app, businessId, (tx) =>
      evidenceRetentionRepo.placeHold(tx, {
        businessId,
        paymentEvidenceId: id,
        kind: 'dispute',
        reason: 'customer disputes the amount',
        placedBy: 'user:ada',
      }),
    );

    expect(await evidenceRetentionRepo.dueForExpiry(worker, new Date())).toEqual([]);
    /* And the pinned write re-checks, so a hold placed after discovery is
     * honoured too. */
    expect(
      await withBusiness(app, businessId, (tx) =>
        evidenceRetentionRepo.expireEvidence(tx, businessId, [id]),
      ),
    ).toBe(0);

    await withBusiness(app, businessId, (tx) =>
      evidenceRetentionRepo.releaseHold(tx, { businessId, holdId, releasedBy: 'user:ada' }),
    );
    expect(await evidenceRetentionRepo.dueForExpiry(worker, new Date())).toHaveLength(1);
  });
});

describe('purge: the picture dies, the claim survives', () => {
  it('clears the media pointer past the countdown and keeps the financial facts', async () => {
    const businessId = await seedBusiness();
    const id = await seedEvidence(businessId, {
      state: 'EXPIRED',
      resolvedAt: daysAgo(RETENTION.evidenceRawDays + 1),
    });

    const cutoff = retentionCutoff(new Date(), RETENTION.evidenceRawDays);
    const due = await evidenceRetentionRepo.dueForPurge(worker, cutoff);
    expect(due).toEqual([{ businessId, evidenceId: id }]);

    const refs = await withBusiness(app, businessId, (tx) =>
      evidenceRetentionRepo.purgeRaw(tx, businessId, [id], cutoff),
    );
    expect(refs).toEqual(['r2://evidence/x']);

    const row = await withBusiness(app, businessId, (tx) =>
      tx.execute<{
        media_ref: string | null;
        raw_purged_at: Date | null;
        claimed_amount_k: string | number;
        resolution_state: string;
      }>(sql`
        SELECT media_ref, raw_purged_at, claimed_amount_k, resolution_state
        FROM payment_evidence WHERE id = ${id}::uuid
      `),
    );
    const after = [...row][0]!;
    expect(after.media_ref).toBeNull();
    expect(after.raw_purged_at).not.toBeNull();
    /* §23: the claim, its amount and its outcome survive. */
    expect(Number(after.claimed_amount_k)).toBe(45_000);
    expect(after.resolution_state).toBe('EXPIRED');
  });

  it('waits out the countdown, skips the already purged, and skips the mediales', async () => {
    const businessId = await seedBusiness();
    /* Resolved recently: not due yet. */
    await seedEvidence(businessId, { state: 'RESOLVED', resolvedAt: daysAgo(2) });
    /* Old but never had media: nothing to purge. */
    await seedEvidence(businessId, {
      state: 'EXPIRED',
      resolvedAt: daysAgo(RETENTION.evidenceRawDays + 5),
      media: null,
    });

    const cutoff = retentionCutoff(new Date(), RETENTION.evidenceRawDays);
    expect(await evidenceRetentionRepo.dueForPurge(worker, cutoff)).toEqual([]);
  });

  it('is suspended by an active hold: a dispute keeps its picture', async () => {
    const businessId = await seedBusiness();
    const id = await seedEvidence(businessId, {
      state: 'RESOLVED',
      resolvedAt: daysAgo(RETENTION.evidenceRawDays + 10),
    });
    await withBusiness(app, businessId, (tx) =>
      evidenceRetentionRepo.placeHold(tx, {
        businessId,
        paymentEvidenceId: id,
        kind: 'tax_audit',
        reason: 'FIRS audit of the 2026 year',
        placedBy: 'operator:support',
      }),
    );

    const cutoff = retentionCutoff(new Date(), RETENTION.evidenceRawDays);
    expect(await evidenceRetentionRepo.dueForPurge(worker, cutoff)).toEqual([]);
    expect(
      await withBusiness(app, businessId, (tx) =>
        evidenceRetentionRepo.purgeRaw(tx, businessId, [id], cutoff),
      ),
    ).toEqual([]);
  });
});

describe('the holds themselves', () => {
  it('releases once, naming who, and never twice', async () => {
    const businessId = await seedBusiness();
    const id = await seedEvidence(businessId, { deadline: daysAgo(1) });
    const { holdId } = await withBusiness(app, businessId, (tx) =>
      evidenceRetentionRepo.placeHold(tx, {
        businessId,
        paymentEvidenceId: id,
        kind: 'investigation',
        reason: 'chargeback investigation',
        placedBy: 'operator:support',
      }),
    );
    expect(
      await withBusiness(app, businessId, (tx) =>
        evidenceRetentionRepo.releaseHold(tx, { businessId, holdId, releasedBy: 'operator:x' }),
      ),
    ).toBe(true);
    expect(
      await withBusiness(app, businessId, (tx) =>
        evidenceRetentionRepo.releaseHold(tx, { businessId, holdId, releasedBy: 'operator:y' }),
      ),
    ).toBe(false);
  });

  it('refuses a blank reason, and refuses deletion by the application', async () => {
    const businessId = await seedBusiness();
    const id = await seedEvidence(businessId, { deadline: daysAgo(1) });
    await expect(
      withBusiness(app, businessId, (tx) =>
        evidenceRetentionRepo.placeHold(tx, {
          businessId,
          paymentEvidenceId: id,
          kind: 'dispute',
          reason: '   ',
          placedBy: 'user:ada',
        }),
      ),
    ).rejects.toThrow();

    await withBusiness(app, businessId, (tx) =>
      evidenceRetentionRepo.placeHold(tx, {
        businessId,
        paymentEvidenceId: id,
        kind: 'dispute',
        reason: 'real',
        placedBy: 'user:ada',
      }),
    );
    await expect(
      withBusiness(app, businessId, (tx) => tx.execute(sql`DELETE FROM evidence_legal_holds`)),
    ).rejects.toThrow();
  });

  it("keeps one tenant's holds invisible to another", async () => {
    const mine = await seedBusiness();
    const theirs = await seedBusiness();
    const id = await seedEvidence(mine, { deadline: daysAgo(1) });
    await withBusiness(app, mine, (tx) =>
      evidenceRetentionRepo.placeHold(tx, {
        businessId: mine,
        paymentEvidenceId: id,
        kind: 'dispute',
        reason: 'mine',
        placedBy: 'user:ada',
      }),
    );
    const seen = await withBusiness(app, theirs, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM evidence_legal_holds`),
    );
    expect([...seen][0]?.n).toBe(0);
  });
});

describe('the deadline the writers will stamp', () => {
  it('is the raise date plus the published period', () => {
    const raised = new Date('2026-08-01T09:00:00Z');
    const deadline = evidenceResolutionDeadline(raised);
    expect((deadline.getTime() - raised.getTime()) / (24 * HOURS)).toBe(
      RETENTION.evidenceResolutionDays,
    );
  });
});
