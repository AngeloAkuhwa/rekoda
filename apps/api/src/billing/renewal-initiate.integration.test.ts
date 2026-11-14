/**
 * OD-44: a renewal blocked before it could be paid gets a FRESH payment once the gate opens.
 *
 * A renewal raised while Rekoda could not take a payment (OWN-70) has no Paystack session, no
 * provider reference and no event: nothing to recover. When the gate opens, the close pass closes
 * the block and, in the same transaction, enqueues one `billing.renewal_initiate` job for it. That
 * job re-checks the gate and the renewal, and starts a new payment through the ordinary checkout
 * path, which carries every initiation safeguard (one live attempt per charge, a fresh provider
 * reference per attempt, an existing session handed back or verified before it is replaced).
 *
 * The claims pinned here:
 *  - no payment is started while the restriction is still active;
 *  - closing the block queues exactly one initiation, however many passes run;
 *  - the initiation creates a new Paystack session with a new reference, and nothing else: the
 *    charge stays pending, the plan is not extended and the grace clock is not moved;
 *  - a later verified payment settles it as any renewal, exactly once;
 *  - a repeated or concurrent run, and an existing session, never start a second session;
 *  - a provider outage is retried and never opens a second session;
 *  - a renewal no longer owed (paid, cancelled, its cycle moved) is not offered for payment.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { attemptReference } from '@rekoda/core';
import { encryptFacet } from '@rekoda/core/vault';
import { createDb, identity, sql, subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';
import {
  applyFixtureCycle,
  migrate,
  requireUrls,
  settlementDb,
  truncateAll,
  type Urls,
  setPricingSource,
} from '@rekoda/db/testing';
import { loadConfig, type ApiConfig } from '../config.js';
import { StubPaymentProvider } from '../payments/provider.stub.js';
import { initiateBlockedRenewalHandler } from '../jobs/initiate-blocked-renewal.handler.js';
import { applySettledCharge } from './billing.service.js';
import { BillingCheckoutService } from './billing-checkout.service.js';
import { sweepRenewals } from './renewal-sweep.js';

const DAY = 86_400_000;
const LIVE = ['sk', 'live', 'q'.repeat(24)].join('_');
const TEST = ['sk', 'test', 'q'.repeat(24)].join('_');
const RUN_SALT = randomBytes(16).toString('hex');
const testKey = (label: string): string =>
  createHash('sha256').update(`${label}:${process.pid}:${RUN_SALT}`).digest('hex');

let urls: Urls;
let db: Db;
let workerDb: Db;
let closeDb: () => Promise<void>;
let closeWorker: () => Promise<void>;
let config: ApiConfig;
let provider: StubPaymentProvider;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 6 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));
  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = testKey('pepper');
  process.env['REKODA_API_SECRET'] = testKey('secret');
  process.env['VAULT_KEY'] = testKey('vault');
  process.env['MATCH_KEY'] = testKey('match');
  config = {
    ...loadConfig(),
    paystackSecretKey: TEST,
    paystackPlatformConfirmed: false,
    webUrl: 'https://app.example.ng',
    planCatalogueReads: false,
  };
});

afterAll(async () => {
  await closeDb?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
  /* This suite prices from the compiled constants; the database is told so (OD-51.6, 0215). */
  await setPricingSource(urls, 'constants');
  provider = new StubPaymentProvider();
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
    `+23481940000${String(phoneSeq).padStart(2, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const renewsAt = new Date(Date.now() - DAY);
  await withBusiness(db, business.id, (tx) =>
    applyFixtureCycle(tx, business.id, {
      plan: 'chat',
      cycleStartedAt: new Date(renewsAt.getTime() - 30 * DAY),
      renewsAt,
      anchorDay: renewsAt.getUTCDate(),
    }),
  );
  return business.id;
}

async function withBillingEmail(businessId: string): Promise<void> {
  await withBusiness(db, businessId, (tx) =>
    subscriptionsRepo.setBillingEmailSealed(
      tx,
      businessId,
      encryptFacet('ada@shop.example.ng', config.vaultKey, `billing-email:${businessId}`),
      new Date(),
    ),
  );
}

/** A renewal raised while the live key was unconfirmed, then the gate opened (a test key). */
async function blockedThenOpened(): Promise<{ businessId: string; reference: string }> {
  const businessId = await dueBusiness();
  await sweepRenewals({ workerDb, appDb: db, config: gated(LIVE) });
  await sweepRenewals({ workerDb, appDb: db, config: gated(TEST) });
  const [charge] = await chargesOf(businessId);
  return { businessId, reference: charge!.reference };
}

interface ChargeRow extends Record<string, unknown> {
  reference: string;
  status: string;
  blocked_at: string | null;
  blocked_resolved_at: string | null;
  provider_reference: string | null;
  paid_at: string | null;
}
const chargesOf = async (businessId: string): Promise<ChargeRow[]> => [
  ...(await withBusiness(db, businessId, (tx) =>
    tx.execute<ChargeRow>(sql`
      SELECT reference, status, blocked_at, blocked_resolved_at, provider_reference, paid_at
      FROM subscription_charges WHERE business_id = ${businessId}::uuid ORDER BY created_at`),
  )),
];

const initiationJobs = async (businessId: string) => [
  ...(await withBusiness(db, businessId, (tx) =>
    tx.execute<{ payload: { reference: string }; singleton_key: string; state: string }>(sql`
      SELECT payload, singleton_key, state FROM jobs
      WHERE business_id = ${businessId}::uuid AND kind = 'billing.renewal_initiate'`),
  )),
];

const attemptsOf = async (businessId: string) => [
  ...(await withBusiness(db, businessId, (tx) =>
    tx.execute<{ provider_reference: string; status: string }>(sql`
      SELECT a.provider_reference, a.status FROM subscription_charge_attempts a
      WHERE a.business_id = ${businessId}::uuid ORDER BY a.attempt_no`),
  )),
];

const outcomes = async (businessId: string) =>
  [
    ...(await withBusiness(db, businessId, (tx) =>
      tx.execute<{
        new_value: { outcome: string; reason?: string; providerReference?: string };
      }>(sql`
        SELECT new_value FROM audit_events
        WHERE business_id = ${businessId}::uuid AND action = 'renewal_payment_initiation'
        ORDER BY created_at, id`),
    )),
  ].map((r) => r.new_value);

const subOf = (businessId: string) =>
  withBusiness(db, businessId, (tx) => subscriptionsRepo.subscriptionFor(tx, businessId));

/** Run the job the way the runner does: inside a transaction pinned to the business. */
const runJob = (
  businessId: string,
  reference: string,
  overrides: Partial<ApiConfig> = {},
  attempt = 1,
  maxAttempts = 5,
) =>
  withBusiness(db, businessId, (tx) =>
    initiateBlockedRenewalHandler({ config: { ...config, ...overrides }, appDb: db, provider })({
      tx,
      jobId: '00000000-0000-0000-0000-000000000000',
      businessId,
      payload: { reference },
      attempt,
      maxAttempts,
    }),
  );

describe('OD-44: closing a block queues one fresh initiation', () => {
  it('nothing is queued while the restriction is still active', async () => {
    const businessId = await dueBusiness();
    await sweepRenewals({ workerDb, appDb: db, config: gated(LIVE) });
    await sweepRenewals({ workerDb, appDb: db, config: gated(LIVE) });

    const [charge] = await chargesOf(businessId);
    expect(charge).toMatchObject({ status: 'pending', blocked_resolved_at: null });
    expect(await initiationJobs(businessId)).toEqual([]);
  });

  it('the pass that closes the block queues exactly one initiation, and later passes add none', async () => {
    const { businessId, reference } = await blockedThenOpened();
    await sweepRenewals({ workerDb, appDb: db, config: gated(TEST) });

    const [charge] = await chargesOf(businessId);
    expect(charge?.blocked_resolved_at).not.toBeNull();
    const jobs = await initiationJobs(businessId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      payload: { reference },
      singleton_key: `renewal-initiate:${reference}`,
      state: 'pending',
    });
  });
});

describe('OD-44: the initiation job', () => {
  it('starts a fresh Paystack session with a new reference, and extends nothing', async () => {
    const { businessId, reference } = await blockedThenOpened();
    await withBillingEmail(businessId);
    const before = await subOf(businessId);

    await runJob(businessId, reference);

    expect(provider.initialized).toHaveLength(1);
    expect(provider.initialized[0]).toMatchObject({
      reference: attemptReference(reference, 1),
      currency: 'NGN',
      subaccountCode: null,
    });
    expect(await attemptsOf(businessId)).toEqual([
      { provider_reference: attemptReference(reference, 1), status: 'active' },
    ]);
    expect(await outcomes(businessId)).toEqual([
      { outcome: 'initiated', providerReference: attemptReference(reference, 1) },
    ]);

    /* Initiation is not payment: the charge is still owed and the plan has not moved. */
    const [charge] = await chargesOf(businessId);
    expect(charge).toMatchObject({ status: 'pending', provider_reference: null, paid_at: null });
    const after = await subOf(businessId);
    expect(after?.planExpiresAt?.toISOString()).toBe(before?.planExpiresAt?.toISOString());
    expect(after?.paymentFailedAt?.toISOString()).toBe(before?.paymentFailedAt?.toISOString());
    expect(after?.plan).toBe(before?.plan);
  });

  it('a verified payment on the new session then settles the renewal exactly once', async () => {
    const { businessId, reference } = await blockedThenOpened();
    await withBillingEmail(businessId);
    await runJob(businessId, reference);
    const before = await subOf(businessId);

    const settle = () =>
      withBusiness(settlementDb(), businessId, (tx) =>
        applySettledCharge(tx, {
          businessId,
          reference,
          providerReference: attemptReference(reference, 1),
          when: new Date(),
          config: gated(TEST),
        }),
      );
    expect(await settle()).toBe('applied');
    expect(await settle()).toBe('already_settled');

    const after = await subOf(businessId);
    expect(after?.paymentFailedAt).toBeNull();
    expect(after!.planExpiresAt!.getTime()).toBeGreaterThan(before!.planExpiresAt!.getTime());
    const [charge] = await chargesOf(businessId);
    expect(charge?.status).toBe('paid');
  });

  it('a repeated run hands back the existing session and starts no second one', async () => {
    const { businessId, reference } = await blockedThenOpened();
    await withBillingEmail(businessId);
    await runJob(businessId, reference);
    await runJob(businessId, reference);

    expect(provider.initialized).toHaveLength(1);
    expect((await attemptsOf(businessId)).length).toBe(1);
    expect((await outcomes(businessId)).map((o) => o.outcome)).toEqual([
      'initiated',
      'existing_payment_link',
    ]);
  });

  it('concurrent runs start one session between them', async () => {
    const { businessId, reference } = await blockedThenOpened();
    await withBillingEmail(businessId);

    await Promise.all([
      runJob(businessId, reference),
      runJob(businessId, reference),
      runJob(businessId, reference),
    ]);

    expect(provider.initialized).toHaveLength(1);
    const attempts = await attemptsOf(businessId);
    expect(attempts.filter((a) => a.status === 'active')).toHaveLength(1);
  });

  it('a session the merchant already started is recovered, not replaced', async () => {
    const { businessId, reference } = await blockedThenOpened();
    await withBillingEmail(businessId);
    /* The merchant opened the billing page and started paying before the job ran. */
    const { BillingCheckoutService } = await import('./billing-checkout.service.js');
    const merchant = await new BillingCheckoutService(config, db, provider).checkout(
      businessId,
      reference,
      undefined,
    );
    expect(merchant.state).toBe('ready');

    await runJob(businessId, reference);

    expect(provider.initialized).toHaveLength(1);
    expect((await outcomes(businessId)).map((o) => o.outcome)).toEqual(['existing_payment_link']);
  });

  it('a provider outage is retried, and the retry asks Paystack before starting a new session', async () => {
    const { businessId, reference } = await blockedThenOpened();
    await withBillingEmail(businessId);
    provider.failNextInitializeWith(new Error('connect ECONNREFUSED'));

    await expect(runJob(businessId, reference, {}, 1, 5)).rejects.toThrow();
    expect(await attemptsOf(businessId)).toEqual([
      { provider_reference: attemptReference(reference, 1), status: 'ambiguous' },
    ]);

    await runJob(businessId, reference, {}, 2, 5);
    const attempts = await attemptsOf(businessId);
    expect(attempts.filter((a) => a.status === 'active')).toHaveLength(1);
    expect(attempts.map((a) => a.provider_reference)).toEqual([
      attemptReference(reference, 1),
      attemptReference(reference, 2),
    ]);
    expect((await outcomes(businessId)).map((o) => o.outcome)).toEqual(['initiated']);
  });

  it('an outage on the last attempt is recorded, not thrown into a dead job', async () => {
    const { businessId, reference } = await blockedThenOpened();
    await withBillingEmail(businessId);
    provider.failNextInitializeWith(new Error('connect ECONNREFUSED'));

    await runJob(businessId, reference, {}, 5, 5);
    expect((await outcomes(businessId)).map((o) => o.outcome)).toEqual(['provider_unreachable']);
  });

  it('starts nothing while the restriction is active again', async () => {
    const { businessId, reference } = await blockedThenOpened();
    await withBillingEmail(businessId);

    await runJob(businessId, reference, {
      paystackSecretKey: LIVE,
      paystackPlatformConfirmed: false,
    });

    expect(provider.initialized).toEqual([]);
    expect(await outcomes(businessId)).toEqual([
      { outcome: 'gate_closed', reason: 'awaiting_platform_confirmation' },
    ]);
  });

  it('starts nothing for a block that is still open', async () => {
    const businessId = await dueBusiness();
    await sweepRenewals({ workerDb, appDb: db, config: gated(LIVE) });
    const [charge] = await chargesOf(businessId);
    await withBillingEmail(businessId);

    await runJob(businessId, charge!.reference);

    expect(provider.initialized).toEqual([]);
    expect(await outcomes(businessId)).toEqual([
      { outcome: 'not_eligible', reason: 'still_blocked' },
    ]);
  });

  it('starts nothing once the renewal was paid meanwhile', async () => {
    const { businessId, reference } = await blockedThenOpened();
    await withBillingEmail(businessId);
    await withBusiness(settlementDb(), businessId, (tx) =>
      applySettledCharge(tx, {
        businessId,
        reference,
        providerReference: 'ps_paid_elsewhere',
        when: new Date(),
        config: gated(TEST),
      }),
    );

    await runJob(businessId, reference);

    expect(provider.initialized).toEqual([]);
    expect(await outcomes(businessId)).toEqual([
      { outcome: 'not_eligible', reason: 'not_pending' },
    ]);
  });

  it('starts nothing when the merchant has cancelled', async () => {
    const { businessId, reference } = await blockedThenOpened();
    await withBillingEmail(businessId);
    await withBusiness(db, businessId, (tx) =>
      tx.execute(
        sql`UPDATE businesses SET pending_plan = 'expired' WHERE id = ${businessId}::uuid`,
      ),
    );

    await runJob(businessId, reference);

    expect(provider.initialized).toEqual([]);
    expect(await outcomes(businessId)).toEqual([{ outcome: 'not_eligible', reason: 'cancelled' }]);
  });

  it('starts nothing when the paid-to date has moved since the renewal was raised', async () => {
    const { businessId, reference } = await blockedThenOpened();
    await withBillingEmail(businessId);
    const moved = new Date(Date.now() + 20 * DAY);
    await withBusiness(db, businessId, (tx) =>
      applyFixtureCycle(tx, businessId, {
        plan: 'chat',
        cycleStartedAt: new Date(),
        renewsAt: moved,
        anchorDay: moved.getUTCDate(),
      }),
    );

    await runJob(businessId, reference);

    expect(provider.initialized).toEqual([]);
    expect((await outcomes(businessId)).map((o) => o.reason)).toContain('cycle_moved');
  });

  it('the checkout itself refuses a renewal whose paid-to date moved, so no race can hand out a link', async () => {
    /* The job checks the cycle, then checks out in a separate transaction; the merchant's own
     * checkout does not pass through the job at all. Settlement binds a renewal to the cycle that
     * starts at the paid-to date it was raised against (0206), so a link for a moved cycle would
     * take money that is then set aside. The checkout's own refusal must catch it. */
    const { businessId, reference } = await blockedThenOpened();
    await withBillingEmail(businessId);
    /* Only the paid-to date moves (an operator's period correction, the staging date tool): no
     * plan decision is recorded, so nothing else marks the renewal as retired. */
    const owner = createDb(urls.owner, { max: 1 });
    try {
      await owner.db.execute(sql`UPDATE businesses
          SET plan_expires_at = plan_expires_at + interval '3 days' WHERE id = ${businessId}::uuid`);
    } finally {
      await owner.close();
    }

    const answer = await new BillingCheckoutService(config, db, provider).checkout(
      businessId,
      reference,
      undefined,
    );

    expect(answer).toMatchObject({ state: 'unavailable', reason: 'superseded' });
    expect(provider.initialized).toEqual([]);
  });

  it('without a billing email it starts nothing and says so; the merchant supplies one on the billing page', async () => {
    const { businessId, reference } = await blockedThenOpened();

    await runJob(businessId, reference);

    expect(provider.initialized).toEqual([]);
    expect(await outcomes(businessId)).toEqual([{ outcome: 'requires_billing_email' }]);
  });

  it('refuses a payload that names no subscription charge', async () => {
    const businessId = await dueBusiness();
    await expect(runJob(businessId, 'not-a-reference')).rejects.toThrow(/no subscription charge/);
  });

  it('the audit never carries the checkout link or the billing email', async () => {
    const { businessId, reference } = await blockedThenOpened();
    await withBillingEmail(businessId);
    await runJob(businessId, reference);

    const text = JSON.stringify(await outcomes(businessId));
    expect(text).not.toContain('checkout.stub');
    expect(text).not.toContain('ada@shop');
  });
});
