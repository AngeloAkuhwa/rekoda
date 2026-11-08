/**
 * OWN-70 (PR B item 4): a renewal Rekoda cannot take the payment for is recorded.
 *
 * The renewal sweep applies the same gate as every other Rekoda charge (`chargeGate`): a live key
 * without the §47 confirmation, or no usable key, cannot take money. The renewal row and the grace
 * clock are kept exactly as ADR 0024 describes (OD-44 is open, so nothing resumes or expires
 * differently); what this adds is the record: the charge is stamped blocked with the gate's reason,
 * audited, listed for an operator and alerted on. It is never marked paid, no Paystack reference or
 * event is invented, and a test key or a confirmed live key is unaffected.
 *
 * Case (b) of the plan, a renewal blocked before initiation, has no reference to verify and is not
 * a dead job: it never reaches the recovery path (asserted below).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { evaluateOpsAlerts } from '@rekoda/core';
import {
  createDb,
  deadJobsRepo,
  identity,
  sql,
  subscriptionsRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { sweepRenewals } from './renewal-sweep.js';
import { applySettledCharge } from './billing.service.js';
import { collectOpsSnapshot } from '../health/ops-alerts.js';

const DAY = 86_400_000;
const LIVE = ['sk', 'live', 'r'.repeat(24)].join('_');
const TEST = ['sk', 'test', 'r'.repeat(24)].join('_');

let urls: Urls;
let db: Db;
let workerDb: Db;
let closeDb: () => Promise<void>;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));
});

afterAll(async () => {
  await closeDb?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

const gated = (paystackSecretKey: string, paystackPlatformConfirmed = false) => ({
  planCatalogueReads: false,
  paystackSecretKey,
  paystackPlatformConfirmed,
});

let phoneSeq = 0;
/** A business whose paid Chat month ended a day ago: due for renewal. */
async function dueBusiness(): Promise<string> {
  phoneSeq += 1;
  const user = await identity.upsertUserByPhone(
    db,
    `+23481930000${String(phoneSeq).padStart(2, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const renewsAt = new Date(Date.now() - DAY);
  await withBusiness(db, business.id, (tx) =>
    subscriptionsRepo.applyCycle(tx, business.id, {
      plan: 'chat',
      cycleStartedAt: new Date(renewsAt.getTime() - 30 * DAY),
      renewsAt,
      anchorDay: renewsAt.getUTCDate(),
    }),
  );
  return business.id;
}

interface Row extends Record<string, unknown> {
  reference: string;
  kind: string;
  status: string;
  blocked_at: string | null;
  blocked_reason: string | null;
  provider_reference: string | null;
  paid_at: string | null;
}
const chargesOf = async (businessId: string): Promise<Row[]> => [
  ...(await withBusiness(db, businessId, (tx) =>
    tx.execute<Row>(sql`
      SELECT reference, kind, status, blocked_at, blocked_reason, provider_reference, paid_at
      FROM subscription_charges WHERE business_id = ${businessId}::uuid ORDER BY created_at`),
  )),
];

const subOf = (businessId: string) =>
  withBusiness(db, businessId, (tx) => subscriptionsRepo.subscriptionFor(tx, businessId));

const blockedAlert = async () =>
  evaluateOpsAlerts(await collectOpsSnapshot(workerDb)).find(
    (a) => a.key === 'billing.renewals_blocked',
  );

describe('OWN-70: the renewal sweep applies the charge gate', () => {
  it('a live key without the §47 confirmation: the renewal is raised as before AND recorded as blocked', async () => {
    const businessId = await dueBusiness();
    expect(await sweepRenewals({ workerDb, appDb: db, config: gated(LIVE) })).toEqual({
      raised: 1,
      skipped: 0,
    });

    const [charge] = await chargesOf(businessId);
    expect(charge).toMatchObject({
      kind: 'renewal',
      status: 'pending',
      blocked_reason: 'awaiting_platform_confirmation',
      provider_reference: null,
      paid_at: null,
    });
    expect(charge?.blocked_at).not.toBeNull();
    // The grace clock runs exactly as for any renewal (OD-44 open), and the plan is untouched.
    const sub = await subOf(businessId);
    expect(sub?.paymentFailedAt).not.toBeNull();
    expect(sub?.plan).toBe('chat');

    const listed = await subscriptionsRepo.blockedRenewals(workerDb);
    expect(listed).toMatchObject([
      { reference: charge!.reference, businessId, reason: 'awaiting_platform_confirmation' },
    ]);
    expect(await blockedAlert()).toMatchObject({ severity: 'critical' });

    const audit = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ action: string }>(sql`
        SELECT action FROM audit_events WHERE entity = 'subscription_charge'
          AND entity_id = ${charge!.reference}`),
    );
    expect([...audit].map((a) => a.action)).toEqual(['renewal_blocked']);
  });

  it('no usable key: recorded as payments_not_configured', async () => {
    const businessId = await dueBusiness();
    await sweepRenewals({ workerDb, appDb: db, config: gated('') });
    expect((await chargesOf(businessId))[0]?.blocked_reason).toBe('payments_not_configured');
  });

  it('a confirmed live key and a test key are unaffected: nothing is recorded, no alert', async () => {
    const live = await dueBusiness();
    await sweepRenewals({ workerDb, appDb: db, config: gated(LIVE, true) });
    expect((await chargesOf(live))[0]).toMatchObject({ status: 'pending', blocked_at: null });

    const test = await dueBusiness();
    await sweepRenewals({ workerDb, appDb: db, config: gated(TEST) });
    expect((await chargesOf(test))[0]).toMatchObject({ status: 'pending', blocked_at: null });

    expect(await subscriptionsRepo.blockedRenewals(workerDb)).toEqual([]);
    expect(await blockedAlert()).toBeUndefined();
  });

  it('a repeated sweep raises and records ONE renewal for the cycle', async () => {
    const businessId = await dueBusiness();
    await sweepRenewals({ workerDb, appDb: db, config: gated(LIVE) });
    await sweepRenewals({ workerDb, appDb: db, config: gated(LIVE) });
    expect(await chargesOf(businessId)).toHaveLength(1);
    expect(await subscriptionsRepo.blockedRenewalCount(workerDb)).toBe(1);
  });

  it('a cancelled subscription raises nothing, so nothing is blocked', async () => {
    const businessId = await dueBusiness();
    await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, 'expired'),
    );
    await sweepRenewals({ workerDb, appDb: db, config: gated(LIVE) });
    expect(await chargesOf(businessId)).toHaveLength(0);
    expect(await subscriptionsRepo.blockedRenewalCount(workerDb)).toBe(0);
  });

  it('an expired subscription raises nothing, so nothing is blocked', async () => {
    const businessId = await dueBusiness();
    await withBusiness(db, businessId, async (tx) => {
      await subscriptionsRepo.markRenewalFailed(tx, businessId, new Date(Date.now() - 10 * DAY));
      expect(
        await subscriptionsRepo.expireSubscription(tx, businessId, 'system:test', 'grace'),
      ).toBe('chat');
    });
    await sweepRenewals({ workerDb, appDb: db, config: gated(LIVE) });
    expect(await chargesOf(businessId)).toHaveLength(0);
    expect(await subscriptionsRepo.blockedRenewalCount(workerDb)).toBe(0);
  });

  it('a blocked renewal is never a dead job: there is nothing for the recovery path to verify', async () => {
    await dueBusiness();
    await sweepRenewals({ workerDb, appDb: db, config: gated(LIVE) });
    expect(await deadJobsRepo.opsQueue(workerDb)).toEqual([]);
  });
});

describe('OWN-70: what happens to a blocked renewal afterwards', () => {
  it('paid once the gate opens (through the ordinary settled path), it leaves the list and extends once', async () => {
    const businessId = await dueBusiness();
    await sweepRenewals({ workerDb, appDb: db, config: gated(LIVE) });
    const [charge] = await chargesOf(businessId);
    const settle = () =>
      withBusiness(db, businessId, (tx) =>
        applySettledCharge(tx, {
          businessId,
          reference: charge!.reference,
          providerReference: 'ps_renewal_after_confirmation',
          when: new Date(),
          config: gated(LIVE, true),
        }),
      );

    expect(await settle()).toBe('applied');
    const renewsAt = (await subOf(businessId))?.planExpiresAt?.toISOString();
    expect(await settle()).toBe('already_settled');
    expect((await subOf(businessId))?.planExpiresAt?.toISOString()).toBe(renewsAt);
    expect(await subscriptionsRepo.blockedRenewals(workerDb)).toEqual([]);
    expect(await blockedAlert()).toBeUndefined();
  });

  it('the next sweep after the gate opens closes the block itself, audited, and the alert clears', async () => {
    const businessId = await dueBusiness();
    await sweepRenewals({ workerDb, appDb: db, config: gated(LIVE) });
    expect(await blockedAlert()).toBeDefined();
    const [charge] = await chargesOf(businessId);

    await sweepRenewals({ workerDb, appDb: db, config: gated(LIVE, true) });

    expect(await subscriptionsRepo.blockedRenewals(workerDb)).toEqual([]);
    expect(await blockedAlert()).toBeUndefined();
    expect((await chargesOf(businessId))[0]?.status).toBe('pending');
    const audit = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ action: string; actor: string; source_type: string }>(sql`
        SELECT action, actor, source_type FROM audit_events WHERE entity = 'subscription_charge'
          AND entity_id = ${charge!.reference} ORDER BY created_at`),
    );
    expect([...audit]).toEqual([
      { action: 'renewal_blocked', actor: 'system:renewal_sweep', source_type: 'system' },
      { action: 'renewal_block_resolved', actor: 'system:gate_open', source_type: 'system' },
    ]);
  });

  it('a failing block cleanup never stops the sweep raising the renewals that are due', async () => {
    const blocked = await dueBusiness();
    await sweepRenewals({ workerDb, appDb: db, config: gated(LIVE) });
    expect(await subscriptionsRepo.blockedRenewals(workerDb)).toHaveLength(1);
    const due = await dueBusiness();
    // The first read on the worker credential (the block listing) fails once.
    let failed = false;
    const flaky = new Proxy(workerDb, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if ((prop === 'execute' || prop === 'select') && typeof value === 'function' && !failed) {
          failed = true;
          return () => {
            throw new Error('listing failed');
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(
      sweepRenewals({ workerDb: flaky, appDb: db, config: gated(LIVE, true) }),
    ).resolves.toMatchObject({ raised: 1 });

    expect(failed).toBe(true);
    expect((await chargesOf(due)).filter((c) => c.kind === 'renewal')).toHaveLength(1);
    // Cleanup is retried by the next pass.
    await sweepRenewals({ workerDb, appDb: db, config: gated(LIVE, true) });
    expect(await subscriptionsRepo.blockedRenewals(workerDb)).toEqual([]);
    expect((await chargesOf(blocked))[0]?.blocked_at).not.toBeNull();
  });

  it('a renewal that was paid meanwhile cannot be given a block resolution', async () => {
    const businessId = await dueBusiness();
    await sweepRenewals({ workerDb, appDb: db, config: gated(LIVE) });
    const [charge] = await chargesOf(businessId);
    await withBusiness(db, businessId, (tx) =>
      applySettledCharge(tx, {
        businessId,
        reference: charge!.reference,
        providerReference: 'ps_paid_meanwhile',
        when: new Date(),
        config: gated(LIVE, true),
      }),
    );
    expect(
      await withBusiness(db, businessId, (tx) =>
        subscriptionsRepo.resolveBlockedRenewal(
          tx,
          businessId,
          charge!.reference,
          'too late to matter',
          'operator:alice',
        ),
      ),
    ).toBe(false);
  });

  it('a renewal superseded meanwhile cannot be given a block resolution', async () => {
    const businessId = await dueBusiness();
    await sweepRenewals({ workerDb, appDb: db, config: gated(LIVE) });
    const [charge] = await chargesOf(businessId);
    const owner = createDb(urls.owner, { max: 1 });
    await owner.db.execute(
      sql`UPDATE subscription_charges SET superseded_at = now() WHERE reference = ${charge!.reference}`,
    );
    await owner.close();
    const resolved = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.resolveBlockedRenewal(tx, businessId, charge!.reference, 'stale', 'op:a'),
    );
    expect(resolved).toBe(false);
  });

  it('an operator closes it with a resolution, once; the charge and the grace clock are untouched', async () => {
    const businessId = await dueBusiness();
    await sweepRenewals({ workerDb, appDb: db, config: gated(LIVE) });
    const [charge] = await chargesOf(businessId);
    const before = await subOf(businessId);
    const close = () =>
      withBusiness(db, businessId, (tx) =>
        subscriptionsRepo.resolveBlockedRenewal(
          tx,
          businessId,
          charge!.reference,
          'merchant told to pay from billing once confirmed',
          'operator:alice',
        ),
      );

    expect(await close()).toBe(true);
    expect(await close()).toBe(false);
    expect(await subscriptionsRepo.blockedRenewals(workerDb)).toEqual([]);
    expect((await chargesOf(businessId))[0]?.status).toBe('pending');
    expect((await subOf(businessId))?.paymentFailedAt?.toISOString()).toBe(
      before?.paymentFailedAt?.toISOString(),
    );
  });

  it('another business cannot mark or close this business’s renewal', async () => {
    const a = await dueBusiness();
    const b = await dueBusiness();
    await sweepRenewals({ workerDb, appDb: db, config: gated(TEST) });
    const [charge] = await chargesOf(a);
    expect(
      await withBusiness(db, b, (tx) =>
        subscriptionsRepo.markRenewalBlocked(tx, b, charge!.reference, 'payments_not_configured'),
      ),
    ).toBe(false);
    expect((await chargesOf(a))[0]?.blocked_at).toBeNull();
  });

  it('the database refuses a block reason it does not know, or a block on a non-renewal', async () => {
    const businessId = await dueBusiness();
    await sweepRenewals({ workerDb, appDb: db, config: gated(TEST) });
    const [charge] = await chargesOf(businessId);
    const refused = (statement: ReturnType<typeof sql>) =>
      withBusiness(db, businessId, (tx) => tx.execute(statement)).then(
        () => 'allowed',
        (error: { cause?: { message?: string } }) => String(error.cause?.message),
      );
    expect(
      await refused(sql`UPDATE subscription_charges SET blocked_at = now(), blocked_reason = 'whim'
                        WHERE reference = ${charge!.reference}`),
    ).toMatch(/blocked_reason_ck/);
    expect(
      await refused(sql`UPDATE subscription_charges SET blocked_at = now(),
                          blocked_reason = 'payments_not_configured', kind = 'upgrade'
                        WHERE reference = ${charge!.reference}`),
    ).toMatch(/blocked_shape_ck/);
  });
});
