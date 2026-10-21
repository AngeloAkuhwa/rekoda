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

describe('a stale paid charge keeps the payment and refuses the plan change', () => {
  it('a pending Complete renewal does not overwrite an operator move to Chat', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete');
    await open(businessId, 'renewal', 'RKD-SUB-STALE-1', 'complete');

    await operator(businessId, 'chat');
    const outcome = await settle(businessId, 'RKD-SUB-STALE-1');

    expect(outcome).toBe('superseded');
    expect((await subscription(businessId))?.plan).toBe('chat');
    const charge = await chargeRow(businessId, 'RKD-SUB-STALE-1');
    expect(charge?.status).toBe('paid'); // the money really arrived
    expect(charge?.superseded_at).not.toBeNull(); // and is surfaced for reconciliation
  });

  it('a pending upgrade does not apply after the operator changed the subscription', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'chat');
    await open(businessId, 'upgrade', 'RKD-SUB-STALE-2', 'complete');

    await operator(businessId, 'integrate');
    const outcome = await settle(businessId, 'RKD-SUB-STALE-2');

    expect(outcome).toBe('superseded');
    expect((await subscription(businessId))?.plan).toBe('integrate');
  });

  it('a pending renewal does not undo a cancellation made after it was opened', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete');
    await open(businessId, 'renewal', 'RKD-SUB-STALE-3', 'complete');

    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, 'expired'),
    );
    const outcome = await settle(businessId, 'RKD-SUB-STALE-3');

    expect(outcome).toBe('superseded');
    const sub = await subscription(businessId);
    expect(sub?.pendingPlan).toBe('expired'); // the cancellation still stands
    expect((await chargeRow(businessId, 'RKD-SUB-STALE-3'))?.status).toBe('paid');
  });

  it('undoing a cancellation is not a newer decision: the open renewal still renews', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete');
    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, 'expired'),
    );
    await open(businessId, 'renewal', 'RKD-SUB-STALE-4', 'complete');

    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, null),
    );

    expect(await settle(businessId, 'RKD-SUB-STALE-4')).toBe('applied');
    expect((await subscription(businessId))?.plan).toBe('complete');
  });

  it('undoing a cancellation made AFTER a renewal opened lets that renewal renew', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete');
    await open(businessId, 'renewal', 'RKD-SUB-STALE-4B', 'complete');
    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, 'expired'),
    );
    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, null),
    );

    expect(await settle(businessId, 'RKD-SUB-STALE-4B')).toBe('applied');
    expect((await subscription(businessId))?.plan).toBe('complete');
  });

  it('undoing a downgrade does not revive a charge opened for the downgrade while it was pending', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete');
    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, 'chat'),
    );
    await open(businessId, 'renewal', 'RKD-SUB-STALE-A', 'chat'); // the sweep prices the pending plan
    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, null),
    );

    expect(await settle(businessId, 'RKD-SUB-STALE-A')).toBe('superseded');
    expect((await subscription(businessId))?.plan).toBe('complete');
  });

  it('a renewal sweep re-reads the subscription under the lock: a move after the due read opens nothing', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete', new Date(Date.now() - 3_600_000)); // due
    let moved = false;
    const workerDb = new Proxy(realWorkerDb, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'execute') return value;
        return async (...args: unknown[]) => {
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          if (!moved) {
            moved = true; // the operator decides between the due read and the lock
            await operator(businessId, 'chat');
          }
          return result;
        };
      },
    }) as Db;

    const swept = await sweepRenewals({ workerDb, appDb, config }, new Date());
    expect(swept.raised).toBe(0);
    expect(moved).toBe(true);

    const charges = await withBusiness(appDb, businessId, async (tx) => {
      const rows = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM subscription_charges WHERE business_id = ${businessId}::uuid`,
      );
      return [...rows][0]?.n;
    });
    expect(charges).toBe(0);
    expect((await subscription(businessId))?.plan).toBe('chat');
  });

  it('a cancellation that lands between the due read and the lock takes effect in the SAME pass', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete', new Date(Date.now() - 3_600_000)); // due
    let cancelled = false;
    const workerDb = new Proxy(realWorkerDb, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'execute') return value;
        return async (...args: unknown[]) => {
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          if (!cancelled) {
            cancelled = true; // the merchant cancels after the sweep read it as due
            await withBusiness(appDb, businessId, (tx) =>
              subscriptionsRepo.schedulePlanChange(tx, businessId, 'expired'),
            );
          }
          return result;
        };
      },
    }) as Db;

    const swept = await sweepRenewals({ workerDb, appDb, config }, new Date());

    expect(cancelled).toBe(true);
    expect(swept.raised).toBe(0); // no renewal is billed for a month they declined
    // ...and the cancellation is applied now, not left for the next scheduled pass.
    expect((await subscription(businessId))?.plan).toBe('expired');
  });

  it('a repeated upgrade request after a newer decision gets a fresh payable charge, not the stale one', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'chat');
    const billing = new BillingService(
      { planCatalogueReads: false, paystackPlatformConfirmed: true } as never,
      appDb,
    );
    const first = await billing.changePlan(businessId, 'complete');
    expect(first.state).toBe('payment_required');
    await operator(businessId, 'integrate'); // a newer decision
    const second = await billing.changePlan(businessId, 'complete');

    expect(second.state).toBe('payment_required');
    if (first.state !== 'payment_required' || second.state !== 'payment_required') return;
    expect(second.reference).not.toBe(first.reference);
    expect(await settle(businessId, first.reference)).toBe('superseded'); // late payment still recorded
    expect(await settle(businessId, second.reference)).toBe('applied');
    expect((await subscription(businessId))?.plan).toBe('complete');
  });

  it('replacing a pending downgrade is a new decision: the charge for the first one is stale', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete');
    const schedule = (plan: string | null) =>
      withBusiness(appDb, businessId, (tx) =>
        subscriptionsRepo.schedulePlanChange(tx, businessId, plan),
      );
    await schedule('chat');
    await open(businessId, 'renewal', 'RKD-SUB-STALE-R', 'chat');
    await schedule('integrate');

    expect(await settle(businessId, 'RKD-SUB-STALE-R')).toBe('superseded');
    expect((await subscription(businessId))?.pendingPlan).toBe('integrate');
  });

  it('a superseded charge is visible to an operator on the charge list', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete');
    await open(businessId, 'renewal', 'RKD-SUB-STALE-V', 'complete');
    await operator(businessId, 'chat');
    await settle(businessId, 'RKD-SUB-STALE-V');

    const charges = await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.chargesFor(tx, businessId),
    );
    const row = charges.rows.find((c) => c.reference === 'RKD-SUB-STALE-V');
    expect(row?.status).toBe('paid');
    expect(row?.supersededAt).toBeInstanceOf(Date);
  });

  it('a stale first purchase does not hold its cycle: the retry gets a fresh payable charge', async () => {
    const businessId = await seedBusiness();
    const billing = new BillingService(
      { planCatalogueReads: false, paystackPlatformConfirmed: true } as never,
      appDb,
    );
    const first = await billing.changePlan(businessId, 'chat');
    expect(first.state).toBe('payment_required');
    await operator(businessId, 'integrate'); // decided meanwhile
    await operator(businessId, 'expired', null);
    const second = await billing.changePlan(businessId, 'chat');

    expect(second.state).toBe('payment_required');
    if (first.state !== 'payment_required' || second.state !== 'payment_required') return;
    expect(second.reference).not.toBe(first.reference);
  });

  it('a renewal pending across an operator change on the same expiry is retired and re-raised by the sweep', async () => {
    const businessId = await seedBusiness();
    const due = new Date(Date.now() - 3_600_000);
    await operator(businessId, 'complete', due);
    const sweep = () => sweepRenewals({ workerDb: realWorkerDb, appDb, config }, new Date());
    expect((await sweep()).raised).toBe(1); // the renewal, and the grace clock

    await operator(businessId, 'complete', due); // clears payment_failed_at, same cycle
    const again = await sweep();

    expect(again.raised).toBe(1); // a current payable renewal, not a collision with the stale one
    const pending = await withBusiness(appDb, businessId, async (tx) => {
      const rows = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM subscription_charges
        WHERE business_id = ${businessId}::uuid AND status = 'pending' AND superseded_at IS NULL`);
      return [...rows][0]?.n;
    });
    expect(pending).toBe(1);
  });

  it('scheduling a change locks the business before the charge rows (no deadlock with a settlement)', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete');
    const schedule = (plan: string | null) =>
      withBusiness(appDb, businessId, (tx) =>
        subscriptionsRepo.schedulePlanChange(tx, businessId, plan),
      );
    await schedule('chat');
    await open(businessId, 'renewal', 'RKD-SUB-STALE-DL', 'chat');

    let scheduling: Promise<void> | undefined;
    const settling = withBusiness(appDb, businessId, async (tx) => {
      await subscriptionsRepo.lockBusiness(tx, businessId); // the settlement's first move
      scheduling = schedule('integrate'); // a replacement that flags the open renewal
      await new Promise((r) => setTimeout(r, 400)); // let it reach its first statement
      return applySettledCharge(tx, {
        businessId,
        reference: 'RKD-SUB-STALE-DL',
        providerReference: 'ps_dl',
        when: new Date(),
        config,
      });
    });

    await expect(settling).resolves.toBeDefined();
    await expect(scheduling).resolves.toBeUndefined();
  });

  it('undoing a cancellation through changePlan lets a renewal opened before it renew', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete');
    await open(businessId, 'renewal', 'RKD-SUB-STALE-UI', 'complete');
    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, 'expired'),
    );
    const billing = new BillingService(
      { planCatalogueReads: false, paystackPlatformConfirmed: true } as never,
      appDb,
    );
    const answer = await billing.changePlan(businessId, 'complete'); // the UI's undo

    expect(answer.state).toBe('scheduled');
    expect(await settle(businessId, 'RKD-SUB-STALE-UI')).toBe('applied');
    expect((await subscription(businessId))?.plan).toBe('complete');
  });

  it('undoing a downgrade keeps an upgrade opened while it was pending: it was priced on the current plan', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'integrate');
    const schedule = (plan: string | null) =>
      withBusiness(appDb, businessId, (tx) =>
        subscriptionsRepo.schedulePlanChange(tx, businessId, plan),
      );
    await schedule('chat');
    await open(businessId, 'upgrade', 'RKD-SUB-STALE-UP', 'complete');
    await schedule(null);

    expect(await settle(businessId, 'RKD-SUB-STALE-UP')).toBe('applied');
    expect((await subscription(businessId))?.plan).toBe('complete');
  });

  it('undoing a cancellation revives a charge that a later upgrade request retired while it was pending', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'chat');
    const schedule = (plan: string | null) =>
      withBusiness(appDb, businessId, (tx) =>
        subscriptionsRepo.schedulePlanChange(tx, businessId, plan),
      );
    await open(businessId, 'upgrade', 'RKD-SUB-STALE-REV', 'complete');
    await schedule('expired');
    /* The merchant asks for another paid plan while the cancellation waits:
     * changePlan retires every plan charge older than the latest decision. */
    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.retireStalePending(tx, businessId),
    );
    await schedule(null);

    expect(await settle(businessId, 'RKD-SUB-STALE-REV')).toBe('applied');
    expect((await subscription(businessId))?.plan).toBe('complete');
  });

  it('a downgrade already pending before the migration (no decision time) is still undoable cleanly', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete');
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`
        UPDATE businesses SET pending_plan = 'chat', plan_decided_at = NULL,
          plan_decided_before_pending = NULL WHERE id = ${businessId}::uuid`),
    );
    await open(businessId, 'renewal', 'RKD-SUB-STALE-LEG', 'chat');
    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, null),
    );

    expect(await settle(businessId, 'RKD-SUB-STALE-LEG')).toBe('superseded');
    expect((await subscription(businessId))?.plan).toBe('complete');
  });

  it('decisions and charges are stamped at statement time, not transaction start', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete');
    const row = await withBusiness(appDb, businessId, async (tx) => {
      await tx.execute(sql`SELECT pg_sleep(0.05)`);
      await subscriptionsRepo.schedulePlanChange(tx, businessId, 'expired');
      await subscriptionsRepo.openCharge(tx, {
        businessId,
        kind: 'renewal',
        plan: 'complete',
        amountK: 990_000,
        reference: 'RKD-SUB-STALE-ORD',
      });
      const rows = await tx.execute<{ decided_late: boolean; charge_late: boolean }>(sql`
        SELECT
          (SELECT plan_decided_at > transaction_timestamp() FROM businesses
            WHERE id = ${businessId}::uuid) AS decided_late,
          (SELECT created_at > transaction_timestamp() FROM subscription_charges
            WHERE reference = 'RKD-SUB-STALE-ORD') AS charge_late
      `);
      return [...rows][0];
    });
    expect(row).toEqual({ decided_late: true, charge_late: true });
  });

  it('the second of two first purchases is superseded by the first', async () => {
    const businessId = await seedBusiness();
    await open(businessId, 'first_purchase', 'RKD-SUB-STALE-5A', 'chat');
    await open(businessId, 'first_purchase', 'RKD-SUB-STALE-5B', 'complete');

    expect(await settle(businessId, 'RKD-SUB-STALE-5B')).toBe('applied');
    expect(await settle(businessId, 'RKD-SUB-STALE-5A')).toBe('superseded');
    expect((await subscription(businessId))?.plan).toBe('complete');
  });

  it('a replayed stale event changes nothing a second time', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete');
    await open(businessId, 'renewal', 'RKD-SUB-STALE-6', 'complete');
    await operator(businessId, 'chat');

    expect(await settle(businessId, 'RKD-SUB-STALE-6')).toBe('superseded');
    const first = await chargeRow(businessId, 'RKD-SUB-STALE-6');
    expect(await settle(businessId, 'RKD-SUB-STALE-6')).toBe('already_settled');

    expect(await chargeRow(businessId, 'RKD-SUB-STALE-6')).toEqual(first);
    expect((await subscription(businessId))?.plan).toBe('chat');
  });
});

describe('a charge that is still current settles normally', () => {
  it('a renewal opened after the last decision renews', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'complete');
    await open(businessId, 'renewal', 'RKD-SUB-CURRENT-1', 'complete');

    expect(await settle(businessId, 'RKD-SUB-CURRENT-1')).toBe('applied');
    const charge = await chargeRow(businessId, 'RKD-SUB-CURRENT-1');
    expect(charge?.status).toBe('paid');
    expect(charge?.superseded_at).toBeNull();
    expect((await subscription(businessId))?.plan).toBe('complete');
  });

  it('a replayed current event applies exactly once', async () => {
    const businessId = await seedBusiness();
    await open(businessId, 'first_purchase', 'RKD-SUB-CURRENT-2', 'chat');

    expect(await settle(businessId, 'RKD-SUB-CURRENT-2')).toBe('applied');
    expect(await settle(businessId, 'RKD-SUB-CURRENT-2')).toBe('already_settled');
  });

  it('a pack bought before an operator plan move still grants its units', async () => {
    const businessId = await seedBusiness();
    await operator(businessId, 'chat');
    await open(businessId, 'add_on', 'RKD-PACK-STALE-1', null);
    await operator(businessId, 'integrate');

    expect(await settle(businessId, 'RKD-PACK-STALE-1')).toBe('applied');
  });
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

  it('an expiry that loses to a concurrent payment stamps no decision and the payment stands', async () => {
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
    expect((await chargeRow(businessId, 'RKD-SUB-ENDED-1'))?.status).toBe('paid');
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
    await operator(businessId, 'chat');
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
