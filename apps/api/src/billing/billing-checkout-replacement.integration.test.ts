/**
 * A lost Paystack checkout link is recoverable (G-102, OWN-50).
 *
 * Paystack rejects a reference it has already seen, so a checkout whose link
 * was lost (the response never reached Rekoda, or the merchant closed the tab)
 * cannot be started again under the same reference. Each provider checkout is
 * an attempt with its own provider reference, and the claims pinned here are
 * the ones the owner named: no duplicate charge, no duplicate entitlement, no
 * two live sessions, no assumption that re-initialising a reference is
 * idempotent, and no waiting for the next day. Failure, timeout, concurrent
 * and recovery cases each have a test.
 *
 * `modelPaystackReferences()` makes the stub behave like Paystack about
 * references: one is accepted once, and a created session can be verified.
 */
// The checkout recovery suite. Split by concern; the rest of this suite is in billing-checkout-
// recovery.integration.test.ts, billing-checkout-guards.integration.test.ts.
import { describe, expect, it } from 'vitest';
import { attemptReference } from '@rekoda/core';
import { subscriptionsRepo, withBusiness } from '@rekoda/db';
import { applySettledCharge } from './billing.service.js';

import {
  appDb,
  config,
  provider,
  checkouts,
  seedBusiness,
  EMAIL,
  pendingCharge,
  ready,
  attemptsOf,
  liveCount,
  chargeCount,
  storeEvent,
  pump,
  drainJobs,
  eventError,
  chargeOf,
  useCheckoutRecoveryHarness,
} from './checkout-recovery.fixtures.js';
import { requireUrls, settlementDb } from '@rekoda/db/testing';

useCheckoutRecoveryHarness();

const expiryOf = (businessId: string) =>
  withBusiness(appDb, businessId, async (tx) => {
    const sub = await subscriptionsRepo.subscriptionFor(tx, businessId);
    return sub?.planExpiresAt?.getTime() ?? null;
  });

/** A charge whose first checkout was lost and replaced: attempts 1 (superseded) and 2 (active). */
async function recoveredCharge(): Promise<{
  businessId: string;
  reference: string;
  amountK: number;
  second: string;
}> {
  const businessId = await seedBusiness();
  const { reference, amountK } = await pendingCharge(businessId);
  provider.loseNextInitializeResponse();
  await expect(checkouts().checkout(businessId, reference, EMAIL)).rejects.toThrow();
  ready(await checkouts().checkout(businessId, reference, undefined));
  return { businessId, reference, amountK, second: attemptReference(reference, 2) };
}

describe('a payment on a replaced checkout', () => {
  it('settles the charge when it is made on the replacement attempt', async () => {
    const { businessId, reference, amountK, second } = await recoveredCharge();
    provider.willVerify(second, { amountK });
    await storeEvent(second, amountK);

    expect(await pump()).toBe(1);
    await drainJobs();

    expect((await chargeOf(businessId, reference))?.status).toBe('paid');
    expect(await attemptsOf(businessId)).toMatchObject([
      { no: 1, status: 'superseded' },
      { no: 2, status: 'paid' },
    ]);
  });

  it('settles the charge when it is made on the older attempt and the charge is still pending', async () => {
    const { businessId, reference, amountK } = await recoveredCharge();
    provider.willVerify(reference, { amountK });
    await storeEvent(reference, amountK);

    await pump();
    await drainJobs();

    expect((await chargeOf(businessId, reference))?.status).toBe('paid');
    expect(await attemptsOf(businessId)).toMatchObject([
      { no: 1, status: 'paid' },
      { no: 2, status: 'superseded' },
    ]);
  });

  it('treats a second payment on the other attempt as a duplicate to refund, never a second entitlement', async () => {
    const { businessId, reference, amountK, second } = await recoveredCharge();
    provider.willVerify(reference, { amountK });
    await storeEvent(reference, amountK);
    await pump();
    await drainJobs();
    const expiryAfterFirst = await expiryOf(businessId);

    provider.willVerify(second, { amountK });
    const duplicate = await storeEvent(second, amountK);
    await pump();
    await drainJobs();

    expect(await eventError(businessId, duplicate)).toBe('duplicate_payment');
    expect(await attemptsOf(businessId)).toMatchObject([
      { no: 1, status: 'paid' },
      { no: 2, status: 'duplicate_paid' },
    ]);
    expect(await expiryOf(businessId)).toBe(expiryAfterFirst);
    expect(await chargeCount(businessId)).toBe(1);
    expect((await chargeOf(businessId, reference))?.status).toBe('paid');
  });

  it('settles once and flags the other when both sessions are paid at the same moment', async () => {
    const { businessId, reference, amountK, second } = await recoveredCharge();
    provider.willVerify(reference, { amountK });
    provider.willVerify(second, { amountK });
    const first = await storeEvent(reference, amountK);
    const other = await storeEvent(second, amountK);
    expect(await pump()).toBe(2);

    await Promise.all([drainJobs(), drainJobs()]);

    expect((await chargeOf(businessId, reference))?.status).toBe('paid');
    const statuses = (await attemptsOf(businessId)).map((a) => a.status).sort();
    expect(statuses).toEqual(['duplicate_paid', 'paid']);
    const errors = [await eventError(businessId, first), await eventError(businessId, other)];
    expect(errors.filter((e) => e === 'duplicate_payment')).toHaveLength(1);
    expect(errors.filter((e) => e === null)).toHaveLength(1);
    expect(await chargeCount(businessId)).toBe(1);
  });

  it('does not mistake a repeat of the settling payment for a duplicate', async () => {
    const { businessId, reference, amountK } = await recoveredCharge();
    provider.willVerify(reference, { amountK });
    await storeEvent(reference, amountK);
    await pump();
    await drainJobs();

    const repeat = await storeEvent(reference, amountK);
    await pump();
    await drainJobs();

    expect(await eventError(businessId, repeat)).toBe('already_paid');
    expect((await attemptsOf(businessId))[0]).toMatchObject({ no: 1, status: 'paid' });
  });

  it('does not close the charge because a replaced attempt was reported failed', async () => {
    const { businessId, reference, amountK, second } = await recoveredCharge();
    provider.willVerify(reference, { amountK, succeeded: false, providerStatus: 'failed' });
    await storeEvent(reference, amountK);

    await pump();
    await drainJobs();

    expect((await chargeOf(businessId, reference))?.status).toBe('pending');
    expect((await attemptsOf(businessId))[1]).toMatchObject({ ref: second, status: 'active' });
  });

  it('still closes the charge when the live attempt is reported failed, as before', async () => {
    const businessId = await seedBusiness();
    const { reference, amountK } = await pendingCharge(businessId);
    ready(await checkouts().checkout(businessId, reference, EMAIL));
    provider.willVerify(reference, { amountK, succeeded: false, providerStatus: 'failed' });
    await storeEvent(reference, amountK);

    await pump();
    await drainJobs();

    expect((await chargeOf(businessId, reference))?.status).toBe('failed');
    expect((await attemptsOf(businessId))[0]).toMatchObject({ no: 1, status: 'failed' });
  });
});

describe('a failed replacement does not strand a payment on the older session', () => {
  it('keeps the charge pending when the live attempt fails after an older one was replaced, so the older session can still be paid', async () => {
    const { businessId, reference, amountK, second } = await recoveredCharge();
    provider.willVerify(second, { amountK, succeeded: false, providerStatus: 'failed' });
    await storeEvent(second, amountK);
    await pump();
    await drainJobs();

    expect((await chargeOf(businessId, reference))?.status).toBe('pending');
    expect(await attemptsOf(businessId)).toMatchObject([
      { no: 1, status: 'superseded' },
      { no: 2, status: 'failed' },
    ]);

    /* The merchant still had the first session open and pays on it. */
    provider.willVerify(reference, { amountK });
    await storeEvent(reference, amountK);
    await pump();
    await drainJobs();

    expect((await chargeOf(businessId, reference))?.status).toBe('paid');
    expect((await attemptsOf(businessId))[0]).toMatchObject({ no: 1, status: 'paid' });
  });

  it('records the session as the one that settled the charge when it is paid after being reported failed', async () => {
    const { businessId, reference, amountK, second } = await recoveredCharge();
    provider.willVerify(second, { amountK, succeeded: false, providerStatus: 'abandoned' });
    await storeEvent(second, amountK);
    await pump();
    await drainJobs();
    expect((await attemptsOf(businessId))[1]).toMatchObject({ no: 2, status: 'failed' });

    /* The merchant came back to that very session and paid. */
    provider.willVerify(second, { amountK });
    await storeEvent(second, amountK);
    await pump();
    await drainJobs();
    expect((await chargeOf(businessId, reference))?.status).toBe('paid');
    expect((await attemptsOf(businessId))[1]).toMatchObject({ no: 2, status: 'paid' });

    /* So a repeat of that payment is a repeat, and a payment on the other session is the duplicate. */
    const repeat = await storeEvent(second, amountK);
    provider.willVerify(reference, { amountK });
    const other = await storeEvent(reference, amountK);
    await pump();
    await drainJobs();
    expect(await eventError(businessId, repeat)).toBe('already_paid');
    expect(await eventError(businessId, other)).toBe('duplicate_payment');
  });

  it('flags a replacement payment as a duplicate when a payment with no recorded attempt settled the charge first', async () => {
    const businessId = await seedBusiness();
    const { reference, amountK } = await pendingCharge(businessId);
    const second = attemptReference(reference, 2);
    /* A charge from before attempts existed: its first session has no attempt row,
     * and a replacement (attempt 2) was opened later. */
    await withBusiness(appDb, businessId, async (tx) => {
      const charge = await subscriptionsRepo.chargeByReference(tx, businessId, reference);
      const opened = await subscriptionsRepo.openAttempt(tx, {
        businessId,
        chargeId: charge!.id,
        attemptNo: 2,
        providerReference: second,
      });
      await subscriptionsRepo.recordAttemptCheckout(
        tx,
        businessId,
        opened!.id,
        'https://checkout.stub/second',
        new Date(),
      );
    });
    provider.willVerify(second, { amountK });
    const eventId = await storeEvent(second, amountK);
    await pump();

    /* While the replacement payment is being verified, the original payment settles
     * the charge in another transaction; it has no attempt to record. */
    const verify = provider.verifyTransaction.bind(provider);
    provider.verifyTransaction = async (ref) => {
      const answer = await verify(ref);
      await withBusiness(settlementDb(), businessId, (tx) =>
        applySettledCharge(tx, {
          businessId,
          reference,
          providerReference: 'legacy-payment',
          paidAmountK: amountK,
          when: new Date(),
          config,
        }),
      );
      return answer;
    };
    await drainJobs();

    expect((await chargeOf(businessId, reference))?.status).toBe('paid');
    expect(await eventError(businessId, eventId)).toBe('duplicate_payment');
    expect((await attemptsOf(businessId))[0]).toMatchObject({ no: 2, status: 'duplicate_paid' });
  });

  it('does not call a payment on a closed charge a duplicate', async () => {
    const businessId = await seedBusiness();
    const { reference, amountK } = await pendingCharge(businessId);
    const second = attemptReference(reference, 2);
    await withBusiness(appDb, businessId, async (tx) => {
      const charge = await subscriptionsRepo.chargeByReference(tx, businessId, reference);
      const opened = await subscriptionsRepo.openAttempt(tx, {
        businessId,
        chargeId: charge!.id,
        attemptNo: 2,
        providerReference: second,
      });
      await subscriptionsRepo.recordAttemptCheckout(
        tx,
        businessId,
        opened!.id,
        'https://checkout.stub/second',
        new Date(),
      );
    });
    provider.willVerify(second, { amountK });
    const eventId = await storeEvent(second, amountK);
    await pump();

    /* While the payment is being verified the charge is closed as failed, not paid. */
    const verify = provider.verifyTransaction.bind(provider);
    provider.verifyTransaction = async (ref) => {
      const answer = await verify(ref);
      await withBusiness(settlementDb(), businessId, async (tx) => {
        await subscriptionsRepo.lockBusiness(tx, businessId);
        await subscriptionsRepo.settleCharge(tx, {
          reference,
          status: 'failed',
          failureReason: 'abandoned',
          when: new Date(),
        });
      });
      return answer;
    };
    await drainJobs();

    expect((await chargeOf(businessId, reference))?.status).toBe('failed');
    expect(await eventError(businessId, eventId)).toBe('already_settled');
    expect((await attemptsOf(businessId))[0]).not.toMatchObject({ status: 'duplicate_paid' });
  });

  it('lets the merchant start a new session on a charge whose only live attempt failed', async () => {
    const { businessId, reference, second } = await recoveredCharge();
    provider.willVerify(second, { amountK: 0, succeeded: false, providerStatus: 'failed' });
    await storeEvent(second, 0);
    await pump();
    await drainJobs();

    const again = ready(await checkouts().checkout(businessId, reference, undefined));

    expect(again.checkoutUrl).toContain(attemptReference(reference, 3));
    expect(await liveCount(businessId)).toBe(1);
  });
});

describe('a failure report racing a replacement', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('does not close the charge when the live attempt is replaced while the failure is being processed', async () => {
    const businessId = await seedBusiness();
    const { reference, amountK } = await pendingCharge(businessId);
    ready(await checkouts().checkout(businessId, reference, EMAIL));
    provider.willVerify(reference, { amountK, succeeded: false, providerStatus: 'failed' });
    await storeEvent(reference, amountK);
    await pump();

    /* A restart is mid-way through replacing the attempt: it holds the business and
     * has not committed, as `replace` does between retiring one attempt and opening
     * the next. */
    let release!: () => void;
    let replacing!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const replacingP = new Promise<void>((resolve) => (replacing = resolve));
    const replacement = withBusiness(appDb, businessId, async (tx) => {
      await subscriptionsRepo.lockBusiness(tx, businessId);
      const charge = await subscriptionsRepo.chargeByReference(tx, businessId, reference);
      const live = await subscriptionsRepo.liveAttempt(tx, businessId, charge!.id);
      await subscriptionsRepo.moveAttempt(tx, businessId, live!.id, ['active'], 'superseded');
      const next = await subscriptionsRepo.openAttempt(tx, {
        businessId,
        chargeId: charge!.id,
        attemptNo: 2,
        providerReference: attemptReference(reference, 2),
      });
      await subscriptionsRepo.recordAttemptCheckout(
        tx,
        businessId,
        next!.id,
        'https://checkout.stub/replacement',
        new Date(),
      );
      replacing();
      await held;
    });
    await replacingP;

    const processing = drainJobs();
    await sleep(500);
    release();
    await replacement;
    await processing;

    /* The failure was about the session that has just been replaced. */
    expect((await chargeOf(businessId, reference))?.status).toBe('pending');
    expect(await attemptsOf(businessId)).toMatchObject([
      { no: 1, status: 'superseded' },
      { no: 2, status: 'active' },
    ]);
  });
});
