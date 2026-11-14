/**
 * A paid Rekoda charge that was set aside instead of applied, for the operator exception queue's
 * tests. Opened by the application and settled by settlement, as in production (0209, 0217): the
 * two halves run on their own credentials.
 */
import { subscriptionsRepo, withBusiness } from '@rekoda/db';
import { applicationDb, settlementDb } from '@rekoda/db/testing';

export async function paidButUnappliedCharge(
  businessId: string,
  reference: string,
  unappliedAt: Date,
): Promise<void> {
  await withBusiness(applicationDb(), businessId, (tx) =>
    subscriptionsRepo.openCharge(tx, {
      businessId,
      kind: 'first_purchase',
      plan: 'chat',
      amountK: 990_000,
      reference,
      periodStart: new Date(),
      periodEnd: new Date(Date.now() + 30 * 86_400_000),
    }),
  );
  await withBusiness(settlementDb(), businessId, async (tx) => {
    await subscriptionsRepo.settleCharge(tx, { reference, status: 'paid', when: new Date() });
    await subscriptionsRepo.markUnapplied(
      tx,
      reference,
      'subscription_decided_after_charge',
      unappliedAt,
    );
  });
}
