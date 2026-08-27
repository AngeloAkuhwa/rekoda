/**
 * The persisted policy (spec §12.5; PR-044): versioned, forward-looking,
 * audited, append-only — and resolved BY DATE, which is the whole
 * mechanism by which historical accounting never changes because a policy
 * changed later. Plus the §12 prerequisite PR-030 seeded: CONTRACT_LIABILITY
 * resolves through the chart for every business.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { lagosDay } from '@rekoda/core';
import {
  accountsRepo,
  createDb,
  identity,
  recognitionPolicyRepo,
  sql,
  withBusiness,
  type Db,
} from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 8 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481820${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

describe('the policy rows (§12.5)', () => {
  it('absence means ON_ISSUE_UNCONDITIONAL, the behaviour every business already had', async () => {
    const businessId = await seedBusiness();
    expect(
      await withBusiness(db, businessId, (tx) =>
        recognitionPolicyRepo.receivablePolicyFor(tx, businessId),
      ),
    ).toBe('ON_ISSUE_UNCONDITIONAL');
  });

  it('sets forward, resolves by date, and never rewrites history', async () => {
    const businessId = await seedBusiness();
    const today = lagosDay(new Date());
    const out = await withBusiness(db, businessId, (tx) =>
      recognitionPolicyRepo.setReceivablePolicy(tx, {
        businessId,
        policy: 'ON_FULFILMENT',
        actor: 'user:ada',
      }),
    );
    expect(out).toEqual({ outcome: 'set', effectiveFrom: today });

    /* Today onward: the new policy. Yesterday: still the old one — the
     * resolution date is the accounting date, so a posting for last week
     * asks last week's question and gets last week's answer. */
    expect(
      await withBusiness(db, businessId, (tx) =>
        recognitionPolicyRepo.receivablePolicyFor(tx, businessId, today),
      ),
    ).toBe('ON_FULFILMENT');
    expect(
      await withBusiness(db, businessId, (tx) =>
        recognitionPolicyRepo.receivablePolicyFor(tx, businessId, '2026-01-01'),
      ),
    ).toBe('ON_ISSUE_UNCONDITIONAL');
  });

  it('refuses to backdate: forward-looking means forward', async () => {
    const businessId = await seedBusiness();
    const out = await withBusiness(db, businessId, (tx) =>
      recognitionPolicyRepo.setReceivablePolicy(tx, {
        businessId,
        policy: 'NONE',
        effectiveFrom: '2026-01-01',
        actor: 'user:ada',
      }),
    );
    expect(out.outcome).toBe('backdated');
    expect(
      await withBusiness(db, businessId, (tx) =>
        recognitionPolicyRepo.receivablePolicyHistory(tx, businessId),
      ),
    ).toHaveLength(0);
  });

  it('setting what already stands reports itself instead of minting a row', async () => {
    const businessId = await seedBusiness();
    const out = await withBusiness(db, businessId, (tx) =>
      recognitionPolicyRepo.setReceivablePolicy(tx, {
        businessId,
        policy: 'ON_ISSUE_UNCONDITIONAL',
        actor: 'user:ada',
      }),
    );
    expect(out).toEqual({ outcome: 'already_set', policy: 'ON_ISSUE_UNCONDITIONAL' });
  });

  it('rows are append-only and audited', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      recognitionPolicyRepo.setReceivablePolicy(tx, {
        businessId,
        policy: 'ON_FULFILMENT',
        actor: 'user:ada',
      }),
    );
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`UPDATE receivable_recognition_policies SET policy = 'NONE'
                       WHERE business_id = ${businessId}::uuid`),
      ),
    ).rejects.toThrow();
    const audit = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: string }>(sql`
        SELECT count(*)::bigint AS n FROM audit_events
        WHERE business_id = ${businessId}::uuid
          AND entity = 'receivable_recognition_policy' AND action = 'set'
      `),
    );
    expect(Number([...audit][0]!.n)).toBe(1);
  });

  it('an unknown policy value is unrepresentable', async () => {
    const businessId = await seedBusiness();
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO receivable_recognition_policies (business_id, policy, effective_from, created_by)
          VALUES (${businessId}::uuid, 'WHENEVER', now()::date, 'user:ada')
        `),
      ),
    ).rejects.toThrow();
  });
});

describe('contract liability is real (§12 prerequisite)', () => {
  it('CONTRACT_LIABILITY resolves through the chart for a seeded business', async () => {
    const businessId = await seedBusiness();
    const account = await withBusiness(db, businessId, (tx) =>
      accountsRepo.accountByRole(tx, businessId, 'CONTRACT_LIABILITY'),
    );
    expect(account).not.toBeNull();
    expect(account!.code).toBe('2200');
    expect(account!.type).toBe('liability');
  });
});
