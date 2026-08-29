/**
 * High-risk confirmations against real PostgreSQL (spec Appendix D.3).
 *
 * The claim is the thing worth testing. A confirmation is authority to do
 * something irreversible exactly once, so what matters is that it cannot be
 * spent twice, cannot be spent late, cannot be spent by somebody else, and
 * cannot drift onto a different subject or a different front door. Every one
 * of those is a bug that only shows up in production, on money.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { identity, riskRepo } from './index.js';
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

async function seedBusiness(phone = '+2348150000001'): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const IN_FIVE_MINUTES = () => new Date(Date.now() + 300_000);

const ASK = (businessId: string, over: Partial<riskRepo.OpenConfirmation> = {}) => ({
  businessId,
  command: 'RefundPayment',
  subject: 'pay_1',
  actor: 'user:ada',
  ingress: 'DASHBOARD',
  consequence: 'Refund ₦20,000 to Ada. The money leaves your account.',
  reason: 'customer returned the wig unworn',
  expiresAt: IN_FIVE_MINUTES(),
  ...over,
});

const claim = (businessId: string, id: string, over: Record<string, unknown> = {}) =>
  withBusiness(db, businessId, (tx) =>
    riskRepo.claimConfirmation(tx, {
      businessId,
      id,
      command: 'RefundPayment',
      subject: 'pay_1',
      actor: 'user:ada',
      ingress: 'DASHBOARD',
      ...over,
    }),
  );

describe('opening a confirmation', () => {
  it('keeps the consequence the merchant actually read', async () => {
    const businessId = await seedBusiness();
    const row = await withBusiness(db, businessId, (tx) =>
      riskRepo.openConfirmation(tx, ASK(businessId)),
    );
    expect(row.consequence).toContain('The money leaves your account');
    expect(row.reason).toBe('customer returned the wig unworn');
  });

  /**
   * Appendix D.3: "A missing reason is a refusal, not a blank field." The
   * column enforces it as well as the service, so a caller that finds a way
   * round the service still cannot write one.
   */
  it('refuses a blank reason at the column', async () => {
    const businessId = await seedBusiness();
    await expect(
      withBusiness(db, businessId, (tx) =>
        riskRepo.openConfirmation(tx, ASK(businessId, { reason: '   ' })),
      ),
    ).rejects.toThrow();
  });
});

describe('spending it', () => {
  it('works once', async () => {
    const businessId = await seedBusiness();
    const row = await withBusiness(db, businessId, (tx) =>
      riskRepo.openConfirmation(tx, ASK(businessId)),
    );
    const first = await claim(businessId, row.id);
    expect(first.outcome).toBe('claimed');
  });

  /** Two taps on a refund button. One of them loses, in the database. */
  it('never twice, even simultaneously', async () => {
    const businessId = await seedBusiness();
    const row = await withBusiness(db, businessId, (tx) =>
      riskRepo.openConfirmation(tx, ASK(businessId)),
    );

    const results = await Promise.all([claim(businessId, row.id), claim(businessId, row.id)]);
    expect(results.filter((r) => r.outcome === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'already_used')).toHaveLength(1);
  });

  it('refuses one that has expired, and says so', async () => {
    const businessId = await seedBusiness();
    const row = await withBusiness(db, businessId, (tx) =>
      riskRepo.openConfirmation(tx, ASK(businessId, { expiresAt: new Date(Date.now() + 50) })),
    );
    const late = await claim(businessId, row.id, { now: new Date(Date.now() + 60_000) });
    expect(late.outcome).toBe('expired');
  });

  /**
   * Every binding is in the WHERE, so a confirmation cannot drift. The
   * outcome for a mismatched binding is deliberately the same as for one
   * that does not exist: naming WHICH binding failed tells a caller how to
   * forge the next attempt.
   */
  it.each([
    ['a different actor', { actor: 'user:someone-else' }],
    ['a different command', { command: 'ReopenAccountingPeriod' }],
    ['a different subject', { subject: 'pay_2' }],
    ['a different front door', { ingress: 'PUBLIC_API' }],
  ])('refuses %s', async (_name, over) => {
    const businessId = await seedBusiness();
    const row = await withBusiness(db, businessId, (tx) =>
      riskRepo.openConfirmation(tx, ASK(businessId)),
    );
    const wrong = await claim(businessId, row.id, over);
    expect(wrong.outcome).toBe('not_found');

    /* And the confirmation is still open afterwards: a failed attempt must
     * not burn the merchant's authority to do the thing they agreed to. */
    const right = await claim(businessId, row.id);
    expect(right.outcome).toBe('claimed');
  });

  /** A confirmation belongs to one tenant, and RLS is the second lock. */
  it('cannot be spent by another business', async () => {
    const mine = await seedBusiness('+2348150000001');
    const theirs = await seedBusiness('+2348150000002');
    const row = await withBusiness(db, mine, (tx) => riskRepo.openConfirmation(tx, ASK(mine)));

    const stolen = await withBusiness(db, theirs, (tx) =>
      riskRepo.claimConfirmation(tx, {
        businessId: theirs,
        id: row.id,
        command: 'RefundPayment',
        subject: 'pay_1',
        actor: 'user:ada',
        ingress: 'DASHBOARD',
      }),
    );
    expect(stolen.outcome).toBe('not_found');
    expect((await claim(mine, row.id)).outcome).toBe('claimed');
  });
});

describe('what is still outstanding', () => {
  it('lists the open ones and hides the spent and the stale', async () => {
    const businessId = await seedBusiness();
    const open = await withBusiness(db, businessId, (tx) =>
      riskRepo.openConfirmation(tx, ASK(businessId)),
    );
    const spent = await withBusiness(db, businessId, (tx) =>
      riskRepo.openConfirmation(tx, ASK(businessId, { subject: 'pay_9' })),
    );
    await claim(businessId, spent.id, { subject: 'pay_9' });
    /* Short-lived rather than born expired: the column refuses a confirmation
     * that has already run out, which is the right refusal and the reason
     * this has to age instead. */
    await withBusiness(db, businessId, (tx) =>
      riskRepo.openConfirmation(tx, ASK(businessId, { expiresAt: new Date(Date.now() + 1_000) })),
    );

    const rows = await withBusiness(db, businessId, (tx) =>
      riskRepo.openConfirmationsFor(tx, businessId, new Date(Date.now() + 30_000)),
    );
    expect(rows.map((r) => r.id)).toEqual([open.id]);
  });

  /* A confirmation cannot be opened already dead. Asking a merchant to agree
   * to something that expired before they read it is not asking them. */
  it('refuses to open one that has already expired', async () => {
    const businessId = await seedBusiness();
    await expect(
      withBusiness(db, businessId, (tx) =>
        riskRepo.openConfirmation(tx, ASK(businessId, { expiresAt: new Date(Date.now() - 1_000) })),
      ),
    ).rejects.toThrow();
  });
});

/**
 * A declined consequence is evidence too. Neither application role may delete
 * a confirmation, so an expired unclaimed row stays as the record of a
 * merchant who was shown what a refund would do and chose not to.
 */
describe('the record it leaves', () => {
  it('cannot be deleted by the application', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) => riskRepo.openConfirmation(tx, ASK(businessId)));
    await expect(
      withBusiness(db, businessId, (tx) => tx.execute(sql`DELETE FROM pending_confirmations`)),
    ).rejects.toThrow();
  });
});
