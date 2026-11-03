/**
 * A payment for an OLD subscription decision never overwrites a NEWER one
 * (G-104, G-112).
 *
 * Two facts are kept apart. PAYMENT TRUTH: the provider took the money, so the
 * charge is recorded `paid` and stays in the billing history whatever happens
 * next. ENTITLEMENT: what that payment was meant to buy (a renewal, an
 * upgrade, a first purchase) applies only if nothing newer was decided about
 * the subscription after the charge was opened. A charge that lost that race
 * is marked superseded for an operator to reconcile; no refund policy is
 * invented here.
 */
// The stale charge suite. Split by concern; the rest of this suite is in stale-
// charge.integration.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  billingRepo,
  createDb,
  identity,
  sql,
  subscriptionsRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { applySettledCharge, BillingService } from './billing.service.js';
import { sweepRenewals } from './renewal-sweep.js';

let urls: Urls;
let appDb: Db;
let closeApp: () => Promise<void>;
let realWorkerDb: Db;
let closeWorker: () => Promise<void>;
let ownerDb: Db;
let closeOwner: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 4 }));
  ({ db: realWorkerDb, close: closeWorker } = createDb(urls.worker, { max: 2 }));
  ({ db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 2 }));
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
  await closeOwner?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

const config = { planCatalogueReads: false };
const renewsAt = new Date(Date.now() + 20 * 86_400_000);

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(appDb, `+23481700${String(seq).padStart(4, '0')}`);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Stale Charge Ltd',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const operator = (businessId: string, plan: string, expiresAt: Date | null = renewsAt) =>
  billingRepo.setPlan(appDb, { businessId, plan, expiresAt, actor: 'operator:test-g104' });

/** A standard monthly cycle ending at `renewsAt` (OWN-33: other spans are never prorated). */
const standardCycle = (businessId: string, plan: string) =>
  withBusiness(appDb, businessId, (tx) =>
    subscriptionsRepo.applyCycle(tx, businessId, {
      plan,
      cycleStartedAt: new Date(renewsAt.getTime() - 30 * 86_400_000),
      renewsAt,
      anchorDay: renewsAt.getUTCDate(),
    }),
  );

const open = (
  businessId: string,
  kind: 'first_purchase' | 'renewal' | 'upgrade' | 'add_on',
  reference: string,
  plan: string | null,
) =>
  withBusiness(appDb, businessId, (tx) =>
    subscriptionsRepo.openCharge(tx, {
      businessId,
      kind,
      ...(plan ? { plan } : {}),
      ...(kind === 'add_on' ? { packId: 'messages_100' } : {}),
      amountK: 990_000,
      reference,
    }),
  );

const settle = (businessId: string, reference: string) =>
  withBusiness(appDb, businessId, (tx) =>
    applySettledCharge(tx, {
      businessId,
      reference,
      providerReference: `ps_${reference}`,
      when: new Date(),
      config,
    }),
  );

const subscription = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) => subscriptionsRepo.subscriptionFor(tx, businessId));

const chargeRow = (businessId: string, reference: string) =>
  withBusiness(appDb, businessId, async (tx) => {
    const rows = await tx.execute<{ status: string; superseded_at: string | null }>(sql`
      SELECT status, superseded_at FROM subscription_charges WHERE reference = ${reference}
    `);
    return [...rows][0];
  });

/* OD-30 (OWN-29): grace expiry IS a newer subscription decision, and a paid but
 * unapplied charge is a visible, resolvable operator exception. */
describe('grace expiry is a newer decision (OD-30)', () => {
  const inGrace = async (businessId: string) => {
    await operator(businessId, 'complete', new Date(Date.now() - 8 * 86_400_000));
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`UPDATE businesses SET payment_failed_at = now() - interval '8 days'
                     WHERE id = ${businessId}::uuid`),
    );
  };
  const expireGrace = (businessId: string) =>
    withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.expireSubscription(tx, businessId, 'system:grace-sweep', 'grace'),
    );
  const decidedAt = (businessId: string) =>
    withBusiness(appDb, businessId, async (tx) => {
      const rows = await tx.execute<{ at: string | null }>(
        sql`SELECT plan_decided_at AS at FROM businesses WHERE id = ${businessId}::uuid`,
      );
      return [...rows][0]?.at ?? null;
    });

  it('a renewal opened before grace expiry and paid after it is paid, unapplied, and the plan stays expired', async () => {
    const businessId = await seedBusiness();
    await inGrace(businessId);
    await open(businessId, 'renewal', 'RKD-SUB-GRACE-1', 'complete');
    const before = await subscription(businessId);

    expect(await expireGrace(businessId)).toBe('complete');
    expect(await settle(businessId, 'RKD-SUB-GRACE-1')).toBe('superseded');

    const charge = await chargeRow(businessId, 'RKD-SUB-GRACE-1');
    expect(charge?.status).toBe('paid');
    expect(charge?.superseded_at).not.toBeNull();
    const after = await subscription(businessId);
    expect(after?.plan).toBe('expired');
    expect(after?.planExpiresAt?.getTime()).toBe(before?.planExpiresAt?.getTime()); // no new cycle
    expect(after?.paymentFailedAt).not.toBeNull(); // untouched by the stale renewal

    // replay: exactly one refusal, one exception
    expect(await settle(businessId, 'RKD-SUB-GRACE-1')).toBe('already_settled');
    const queue = await subscriptionsRepo.unappliedCharges(realWorkerDb);
    expect(queue.filter((q) => q.reference === 'RKD-SUB-GRACE-1')).toHaveLength(1);
  });

  it('an expiry that finds the payment already applied stamps no decision and the payment stands', async () => {
    const businessId = await seedBusiness();
    await inGrace(businessId);
    await open(businessId, 'renewal', 'RKD-SUB-GRACE-2', 'complete');

    expect(await settle(businessId, 'RKD-SUB-GRACE-2')).toBe('applied'); // paid first
    const stamped = await decidedAt(businessId);
    expect(await expireGrace(businessId)).toBeNull(); // the sweep lost
    expect(await decidedAt(businessId)).toBe(stamped);
    expect((await subscription(businessId))?.plan).toBe('complete');
  });
});

describe('a paid but unapplied charge is an operator exception (OD-30)', () => {
  it('lists the fields an operator needs, then leaves the queue only when resolved', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete');
    await open(businessId, 'renewal', 'RKD-SUB-OPS-1', 'complete');
    await operator(businessId, 'chat');
    expect(await settle(businessId, 'RKD-SUB-OPS-1')).toBe('superseded');

    /* The merchant's own billing view must not call this payment applied: the money arrived and
     * the plan did not move (the return page keys its "your plan is active" on this). */
    const overview = await new BillingService(
      {
        planCatalogueReads: false,
        paystackSecretKey: 'sk_test_x',
        paystackPlatformConfirmed: true,
      } as never,
      appDb,
    ).overview(businessId);
    expect(overview.charges.find((c) => c.reference === 'RKD-SUB-OPS-1')).toMatchObject({
      status: 'paid',
      applied: false,
    });

    const [row] = (await subscriptionsRepo.unappliedCharges(realWorkerDb)).filter(
      (q) => q.reference === 'RKD-SUB-OPS-1',
    );
    expect(row).toMatchObject({
      businessId,
      kind: 'renewal',
      plan: 'complete',
      amountK: 990_000,
      reason: 'subscription_decided_after_charge',
      currentPlan: 'chat',
    });
    expect(row?.paidAt).not.toBeNull();
    expect(row?.supersededAt).not.toBeNull();

    expect(
      await withBusiness(appDb, businessId, (tx) =>
        subscriptionsRepo.resolveUnapplied(
          tx,
          'RKD-SUB-OPS-1',
          'refunded at Paystack, recorded',
          'operator:test-ops',
        ),
      ),
    ).toBe(true);
    expect(
      (await subscriptionsRepo.unappliedCharges(realWorkerDb)).some(
        (q) => q.reference === 'RKD-SUB-OPS-1',
      ),
    ).toBe(false);
    // a second resolution changes nothing
    expect(
      await withBusiness(appDb, businessId, (tx) =>
        subscriptionsRepo.resolveUnapplied(tx, 'RKD-SUB-OPS-1', 'again', 'operator:late'),
      ),
    ).toBe(false);
  });

  it('a current paid charge is never an exception', async () => {
    const businessId = await seedBusiness();
    await open(businessId, 'first_purchase', 'RKD-SUB-OPS-2', 'chat');
    expect(await settle(businessId, 'RKD-SUB-OPS-2')).toBe('applied');
    expect(
      (await subscriptionsRepo.unappliedCharges(realWorkerDb)).some(
        (q) => q.reference === 'RKD-SUB-OPS-2',
      ),
    ).toBe(false);
  });
});

describe('an upgrade paid after its cycle has ended never leaves the plan expiry in the past (OWN-29)', () => {
  it('is paid, unapplied and says the cycle ended; the expiry and the grace clock are untouched', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'chat');
    await open(businessId, 'upgrade', 'RKD-SUB-ENDED-1', 'complete');
    // The renewal date passes, the sweep fails the renewal, and the merchant is in grace.
    const ended = new Date(Date.now() - 2 * 86_400_000);
    await ownerDb.execute(sql`
      UPDATE businesses
      SET plan_expires_at = ${ended.toISOString()}::timestamptz,
          payment_failed_at = ${ended.toISOString()}::timestamptz,
          plan_decided_at = ${new Date(Date.now() - 20 * 86_400_000).toISOString()}::timestamptz
      WHERE id = ${businessId}::uuid
    `);

    const outcome = await settle(businessId, 'RKD-SUB-ENDED-1');

    expect(outcome).toBe('superseded');
    const sub = await subscription(businessId);
    expect(sub?.plan).toBe('chat'); // not upgraded on a cycle that is over
    expect(sub?.planExpiresAt?.toISOString()).toBe(ended.toISOString()); // still the truth
    expect(sub?.paymentFailedAt).not.toBeNull(); // the grace clock was not cleared
    const ended1 = await chargeRow(businessId, 'RKD-SUB-ENDED-1');
    expect(ended1?.status).toBe('paid');
    expect(ended1?.superseded_at).not.toBeNull(); // surfaced for the operator
    const why = await withBusiness(appDb, businessId, async (tx) => {
      const rows = await tx.execute<{ unapplied_reason: string | null }>(sql`
        SELECT unapplied_reason FROM subscription_charges WHERE reference = 'RKD-SUB-ENDED-1'
      `);
      return [...rows][0]?.unapplied_reason;
    });
    expect(why).toBe('cycle_ended');
  });

  it('an upgrade inside a running cycle still applies', async () => {
    const businessId = await seedBusiness();
    await standardCycle(businessId, 'chat');
    await open(businessId, 'upgrade', 'RKD-SUB-LIVE-1', 'complete');
    expect(await settle(businessId, 'RKD-SUB-LIVE-1')).toBe('applied');
    expect((await subscription(businessId))?.plan).toBe('complete');
  });
});

/**
 * One root cause behind two review findings: a decision that makes the open
 * renewal stale while the merchant is ALREADY in grace left nothing payable
 * (the sweep skips anyone whose grace clock is running), so the merchant lapsed
 * after seven days despite acting. The sweep now raises the correct renewal for
 * a grace business that has no payable one, and never touches the clock.
 */
describe('a grace business whose renewal went stale is given a payable one (G-104)', () => {
  const sweep = () => sweepRenewals({ workerDb: realWorkerDb, appDb, config }, new Date());
  const openRenewals = (businessId: string) =>
    withBusiness(appDb, businessId, async (tx) => {
      const rows = await tx.execute<{ plan: string; amount_k: string }>(sql`
        SELECT plan, amount_k FROM subscription_charges
        WHERE business_id = ${businessId}::uuid AND kind = 'renewal'
          AND status = 'pending' AND superseded_at IS NULL`);
      return [...rows];
    });
  const failedAt = (businessId: string) =>
    withBusiness(appDb, businessId, async (tx) => {
      const rows = await tx.execute<{ t: string }>(sql`
        SELECT payment_failed_at AS t FROM businesses WHERE id = ${businessId}::uuid`);
      return [...rows][0]?.t;
    });

  it('scheduling a downgrade in grace re-raises the renewal for the cheaper plan, grace clock untouched', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete', new Date(Date.now() - 3_600_000));
    expect((await sweep()).raised).toBe(1); // Complete renewal, grace running
    const clock = await failedAt(businessId);
    const stale = await settleProbe(businessId);
    expect(stale).toBe('payable'); // before the decision the link is good

    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, 'chat'),
    );
    const again = await sweep();

    expect(again.raised).toBe(1);
    const open = await openRenewals(businessId);
    expect(open).toHaveLength(1);
    expect(open[0]?.plan).toBe('chat'); // the plan the merchant now asked for
    expect(await failedAt(businessId)).toBe(clock); // seven days still count from the renewal date
  });

  it('undoing a downgrade in grace re-raises the renewal for the current plan', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete', new Date(Date.now() + 3_600_000));
    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, 'chat'),
    );
    await ownerDb.execute(sql`
      UPDATE businesses SET plan_expires_at = now() - interval '1 hour'
      WHERE id = ${businessId}::uuid`);
    expect((await sweep()).raised).toBe(1); // a CHAT renewal, grace running
    expect((await openRenewals(businessId))[0]?.plan).toBe('chat');
    const clock = await failedAt(businessId);

    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, null),
    ); // the merchant keeps Complete
    expect((await sweep()).raised).toBe(1);

    const open = await openRenewals(businessId);
    expect(open).toHaveLength(1);
    expect(open[0]?.plan).toBe('complete');
    expect(await failedAt(businessId)).toBe(clock);
  });

  it('a business whose renewal FAILED and was then re-decided is not re-selected forever (no spin)', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete', new Date(Date.now() - 3_600_000));
    expect((await sweep()).raised).toBe(1);
    // The provider reports the attempt dead: the charge is closed `failed`, and it still holds the cycle.
    await withBusiness(appDb, businessId, async (tx) => {
      const rows = await tx.execute<{ reference: string }>(sql`
        SELECT reference FROM subscription_charges
        WHERE business_id = ${businessId}::uuid AND kind = 'renewal'`);
      await subscriptionsRepo.settleCharge(tx, {
        reference: [...rows][0]!.reference,
        status: 'failed',
        failureReason: 'abandoned',
        when: new Date(),
      });
      await subscriptionsRepo.schedulePlanChange(tx, businessId, 'chat'); // a newer decision
    });

    // The failed row still holds the cycle, so a new renewal cannot be opened: do not pick it up.
    expect(await subscriptionsRepo.dueForRenewal(realWorkerDb, new Date())).toHaveLength(0);
    const again = await sweep();
    expect(again).toEqual({ raised: 0, skipped: 0 });
  });

  it('an operator sees the replacement renewal the merchant is now being asked to pay', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete', new Date(Date.now() - 3_600_000));
    expect((await sweep()).raised).toBe(1); // R1, a Complete renewal
    const r1 = (await openRenewals(businessId))[0] as unknown as { plan: string } | undefined;
    expect(r1?.plan).toBe('complete');
    const ref1 = await withBusiness(appDb, businessId, async (tx) => {
      const rows = await tx.execute<{ reference: string }>(sql`
        SELECT reference FROM subscription_charges
        WHERE business_id = ${businessId}::uuid AND kind = 'renewal'`);
      return [...rows][0]!.reference;
    });
    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, 'chat'),
    ); // R1 is now stale
    expect(await settle(businessId, ref1)).toBe('superseded'); // the merchant pays R1 anyway
    expect((await sweep()).raised).toBe(1); // R2, for Chat

    const queue = await subscriptionsRepo.unappliedCharges(realWorkerDb, 50);
    expect(queue.map((c) => c.reference)).toEqual([ref1]);
    const r2 = await withBusiness(appDb, businessId, async (tx) => {
      const rows = await tx.execute<{ reference: string }>(sql`
        SELECT reference FROM subscription_charges
        WHERE business_id = ${businessId}::uuid AND kind = 'renewal'
          AND status = 'pending' AND superseded_at IS NULL`);
      return [...rows][0]?.reference;
    });
    // The operator can see the merchant has been asked to pay again, and which charge that is.
    expect(r2).toBeDefined();
    expect(queue[0]?.openChargeReference).toBe(r2);
  });

  it('does not raise a second renewal when a payable one already exists', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete', new Date(Date.now() - 3_600_000));
    expect((await sweep()).raised).toBe(1);
    expect((await sweep()).raised).toBe(0);
    expect(await openRenewals(businessId)).toHaveLength(1);
  });

  /** Whether the open renewal would still apply: payable until a newer decision. */
  async function settleProbe(businessId: string): Promise<'payable' | 'stale'> {
    return withBusiness(appDb, businessId, async (tx) => {
      const rows = await tx.execute<{ reference: string }>(sql`
        SELECT reference FROM subscription_charges
        WHERE business_id = ${businessId}::uuid AND status = 'pending' AND kind = 'renewal'`);
      const reference = [...rows][0]?.reference;
      if (!reference) return 'stale';
      return (await subscriptionsRepo.decidedSince(tx, businessId, reference))
        ? 'stale'
        : 'payable';
    });
  }
});
